function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

function cleanCellText(htmlFragment) {
  return decodeHtmlEntities(
    String(htmlFragment || '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function getVnIsoDateWithOffset(dayOffset) {
  const vnMs = Date.now() + 7 * 60 * 60 * 1000 + (Number(dayOffset) || 0) * 86400000;
  const d = new Date(vnMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseShiftingTableFromHtml(html, dayOffset) {
  // Tìm ngày của bản kế hoạch trên trang (ưu tiên cụm "ngày DD/MM/YYYY")
  const mExplicitDate = html.match(/ng[àa]y\s*(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/i)
    || html.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  const planIsoDate = mExplicitDate
    ? `${mExplicitDate[3]}-${mExplicitDate[2].padStart(2, '0')}-${mExplicitDate[1].padStart(2, '0')}`
    : getVnIsoDateWithOffset(dayOffset);

  // Tách đúng vùng bảng bên trong #TD_ShowShipPlan_DiChuyen
  const markerMatch = html.match(/id\s*=\s*["']?TD_ShowShipPlan_DiChuyen["']?/i);
  if (!markerMatch) {
    return { date: planIsoDate, count: 0, rows: [] };
  }

  const afterMarker = html.slice(markerMatch.index);
  const nextSectionIdx = afterMarker.slice(30).search(/id\s*=\s*["']?TD_ShowShipPlan_/i);
  const sectionHtml = nextSectionIdx > 0 ? afterMarker.slice(0, nextSectionIdx + 30) : afterMarker;
  const tableMatch = sectionHtml.match(/<table\b[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) {
    return { date: planIsoDate, count: 0, rows: [] };
  }

  const rows = [];
  const trRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;

  while ((trMatch = trRegex.exec(tableMatch[1])) !== null) {
    const tdRegex = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    const tds = [];
    let tdMatch;
    while ((tdMatch = tdRegex.exec(trMatch[1])) !== null) {
      tds.push(cleanCellText(tdMatch[1]));
    }

    if (tds.length >= 12) {
      const stt = tds[0];
      const timeStr = tds[1];
      if (/^\d+$/.test(stt) && /^\d{1,2}:\d{2}$/.test(timeStr)) {
        const vName = tds[2].toUpperCase();
        const draft = parseFloat(tds[3].replace(',', '.')) || 0;
        const loa = parseFloat(tds[4].replace(',', '.')) || 0;
        const dwt = tds[5].replace(/\./g, '');
        const gt = tds[6].replace(/\./g, '');
        const tugs = tds[7];
        const channel = tds[8];
        const fromPort = tds[9].toUpperCase();
        const toPort = tds[10].toUpperCase();
        const operator = tds[11];
        const pilot = tds[12] || '';
        const padTime = timeStr.padStart(5, '0');

        if (vName && (fromPort || toPort)) {
          rows.push({
            stt: Number(stt),
            date: planIsoDate,
            time: padTime,
            moveAt: `${planIsoDate}T${padTime}:00+07:00`,
            vessel: vName,
            draft,
            loa,
            dwt,
            gt,
            tugs,
            channel,
            fromPort,
            toPort,
            operator,
            pilot
          });
        }
      }
    }
  }

  return { date: planIsoDate, count: rows.length, rows };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const rawD = (req.query && req.query.d !== undefined) ? String(req.query.d).trim() : '0';
  const dNum = /^-?\d+$/.test(rawD) ? Math.max(-7, Math.min(7, parseInt(rawD, 10))) : 0;
  const format = (req.query && req.query.format) ? String(req.query.format).toLowerCase() : 'html';
  const noCache = req.query && (req.query.nocache === '1' || req.query.nocache === 'true');

  res.setHeader(
    'Cache-Control',
    noCache ? 'no-store' : 's-maxage=120, stale-while-revalidate=300'
  );

  const targetUrl = `https://csdltau.cangvuhaiphong.gov.vn/ship_plan.aspx?d=${encodeURIComponent(String(dNum))}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Referer': 'https://cangvuhaiphong.gov.vn/ke-hoach-tau/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8'
      }
    });

    if (!response.ok) {
      return res.status(response.status).send(`Cang vu HTTP ${response.status}`);
    }

    const html = await response.text();

    // Chế độ mới: trả JSON chuẩn cho Kế hoạch tàu di chuyển (#TD_ShowShipPlan_DiChuyen)
    if (format === 'json') {
      const parsed = parseShiftingTableFromHtml(html, dNum);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(200).json({
        source: 'vercel-api-cangvu',
        d: dNum,
        date: parsed.date,
        updatedAt: new Date().toISOString(),
        count: parsed.count,
        rows: parsed.rows
      });
    }

    // Chế độ mặc định: giữ nguyên trả HTML gốc như cũ
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (err) {
    const isTimeout = err && err.name === 'AbortError';
    return res.status(isTimeout ? 504 : 500).send(
      isTimeout ? 'Cang vu request timeout (12s)' : ('Server Error: ' + err.message)
    );
  } finally {
    clearTimeout(timeoutId);
  }
};
