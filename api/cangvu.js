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
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

async function fetchWithTimeout(url, headers, timeoutMs = 5500) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers, redirect: 'follow' });
    const text = res.ok ? await res.text() : '';
    return { ok: res.ok, status: res.status, finalUrl: res.url || url, text };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      finalUrl: url,
      error: err && err.name === 'AbortError' ? 'timeout' : String((err && err.message) || err),
      text: ''
    };
  } finally {
    clearTimeout(id);
  }
}

function extractIframeUrls(parentHtml, baseUrl) {
  const urls = [];
  const iframeRe = /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = iframeRe.exec(parentHtml)) !== null) {
    const raw = decodeHtmlEntities(m[1]).trim();
    if (!raw || /^javascript:|^about:/i.test(raw)) continue;
    if (/youtube|facebook|google\.com\/maps/i.test(raw)) continue;
    try {
      const abs = new URL(raw, baseUrl).toString();
      if (!urls.includes(abs)) urls.push(abs);
    } catch (e) {}
  }
  return urls;
}

function parseShiftingTableFromHtml(html, dayOffset) {
  const mExplicitDate = html.match(/ng[àa]y\s*(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/i)
    || html.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  const planIsoDate = mExplicitDate
    ? `${mExplicitDate[3]}-${mExplicitDate[2].padStart(2, '0')}-${mExplicitDate[1].padStart(2, '0')}`
    : getVnIsoDateWithOffset(dayOffset);

  let sectionHtml = '';
  const markerMatch = html.match(/id\s*=\s*["']?TD_ShowShipPlan_DiChuyen["']?/i);
  if (markerMatch) {
    const afterMarker = html.slice(markerMatch.index);
    const nextIdx = afterMarker.slice(30).search(/id\s*=\s*["']?TD_ShowShipPlan_/i);
    sectionHtml = nextIdx > 0 ? afterMarker.slice(0, nextIdx + 30) : afterMarker;
  } else {
    const titleMatch = html.match(/Kế\s*hoạch\s*tàu\s*di\s*chuyển/i);
    if (titleMatch) {
      const afterTitle = html.slice(titleMatch.index);
      const nextIdx = afterTitle.slice(25).search(/Kế\s*hoạch\s*tàu|id\s*=\s*["']?TD_ShowShipPlan_/i);
      sectionHtml = nextIdx > 0 ? afterTitle.slice(0, nextIdx + 25) : afterTitle;
    }
  }

  if (!sectionHtml) return { date: planIsoDate, count: 0, rows: [] };

  const tableMatch = sectionHtml.match(/<table\b[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return { date: planIsoDate, count: 0, rows: [] };

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
        const fromPort = tds[9].toUpperCase();
        const toPort = tds[10].toUpperCase();
        const padTime = timeStr.padStart(5, '0');

        if (vName && (fromPort || toPort)) {
          rows.push({
            stt: Number(stt),
            date: planIsoDate,
            time: padTime,
            moveAt: `${planIsoDate}T${padTime}:00+07:00`,
            vessel: vName,
            draft: parseFloat(tds[3].replace(',', '.')) || 0,
            loa: parseFloat(tds[4].replace(',', '.')) || 0,
            dwt: tds[5].replace(/\./g, ''),
            gt: tds[6].replace(/\./g, ''),
            tugs: tds[7],
            channel: tds[8],
            fromPort,
            toPort,
            operator: tds[11],
            pilot: tds[12] || ''
          });
        }
      }
    }
  }

  return { date: planIsoDate, count: rows.length, rows };
}

function parseInOutTableFromHtml(html, planIsoDate, kind) {
  let sectionHtml = '';
  const idRegex = kind === 'arrivals'
    ? /id\s*=\s*["']?TD_ShowShipPlan_(?:Vao|Den)[^"'\s>]*/i
    : /id\s*=\s*["']?TD_ShowShipPlan_(?:Roi|Ra)[^"'\s>]*/i;
  const titleRegex = kind === 'arrivals'
    ? /Kế\s*hoạch\s*tàu\s*(?:vào|đến)\s*cảng/i
    : /Kế\s*hoạch\s*tàu\s*(?:rời|ra)\s*cảng/i;

  const mId = html.match(idRegex);
  if (mId) {
    const after = html.slice(mId.index);
    const nextIdx = after.slice(30).search(/id\s*=\s*["']?TD_ShowShipPlan_/i);
    sectionHtml = nextIdx > 0 ? after.slice(0, nextIdx + 30) : after;
  } else {
    const mTitle = html.match(titleRegex);
    if (mTitle) {
      const afterTitle = html.slice(mTitle.index);
      const nextIdx = afterTitle.slice(25).search(/Kế\s*hoạch\s*tàu|id\s*=\s*["']?TD_ShowShipPlan_/i);
      sectionHtml = nextIdx > 0 ? afterTitle.slice(0, nextIdx + 25) : afterTitle;
    }
  }

  if (!sectionHtml) return [];

  const tableMatch = sectionHtml.match(/<table\b[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return [];

  const headers = [];
  const thRegex = /<th\b[^>]*>([\s\S]*?)<\/th>/gi;
  let thM;
  while ((thM = thRegex.exec(tableMatch[1])) !== null) {
    headers.push(cleanCellText(thM[1]).toLowerCase());
  }

  let portColIdx = -1;
  let operatorColIdx = -1;
  if (headers.length) {
    if (kind === 'arrivals') {
      portColIdx = headers.findIndex(h =>
        h.includes('đến') || h.includes('cảng') || h.includes('bến') || h.includes('vị trí')
      );
    } else {
      portColIdx = headers.findIndex(h =>
        h.includes('từ') || h.includes('cảng') || h.includes('bến') || h.includes('vị trí')
      );
    }
    operatorColIdx = headers.findIndex(h => h.includes('đại lý') || h.includes('hãng'));
  }

  const list = [];
  const trRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let trM;

  while ((trM = trRegex.exec(tableMatch[1])) !== null) {
    const tdRegex = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    const tds = [];
    let tdM;
    while ((tdM = tdRegex.exec(trM[1])) !== null) {
      tds.push(cleanCellText(tdM[1]));
    }

    if (tds.length >= 10) {
      const stt = tds[0];
      const timeStr = tds[1];
      if (/^\d+$/.test(stt) && /^\d{1,2}:\d{2}$/.test(timeStr)) {
        const vName = tds[2].toUpperCase();
        const padTime = timeStr.padStart(5, '0');
        const idxPort = (portColIdx >= 0 && portColIdx < tds.length)
          ? portColIdx
          : (tds.length >= 11 ? 10 : tds.length - 2);
        const idxOp = (operatorColIdx >= 0 && operatorColIdx < tds.length)
          ? operatorColIdx
          : idxPort + 1;
        const port = (tds[idxPort] || '').toUpperCase();

        if (vName) {
          list.push({
            date: planIsoDate,
            time: padTime,
            at: `${planIsoDate}T${padTime}:00+07:00`,
            vessel: vName,
            port,
            draft: parseFloat((tds[3] || '').replace(',', '.')) || 0,
            loa: parseFloat((tds[4] || '').replace(',', '.')) || 0,
            dwt: (tds[5] || '').replace(/\./g, ''),
            gt: (tds[6] || '').replace(/\./g, ''),
            operator: tds[idxOp] || ''
          });
        }
      }
    }
  }

  return list;
}

module.exports = async function handler(req, res) {
  const startedAt = Date.now();
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

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Referer': 'https://cangvuhaiphong.gov.vn/ke-hoach-tau/',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8'
  };

  const tried = [];
  let foundHtml = '';
  let foundUrl = '';

  // Bước 1: Tải trang chính để tự dò đúng đường dẫn iframe đang chạy thực tế
  const parentUrl = 'https://cangvuhaiphong.gov.vn/ke-hoach-tau/';
  const parentRes = await fetchWithTimeout(parentUrl, headers, 5500);
  tried.push({ url: parentUrl, status: parentRes.status, error: parentRes.error || null });

  const candidates = [];
  if (parentRes.ok && parentRes.text) {
    if (dNum === 0 && /TD_ShowShipPlan_DiChuyen/i.test(parentRes.text)) {
      foundHtml = parentRes.text;
      foundUrl = parentRes.finalUrl;
    } else {
      const iframes = extractIframeUrls(parentRes.text, parentUrl);
      iframes.forEach(u => {
        try {
          const parsedU = new URL(u);
          if (dNum !== 0) {
            parsedU.searchParams.set('d', String(dNum));
            const withOffset = parsedU.toString();
            if (!candidates.includes(withOffset)) candidates.push(withOffset);
          }
          if (!candidates.includes(u)) candidates.push(u);
        } catch (e) {
          if (!candidates.includes(u)) candidates.push(u);
        }
      });
    }
  }

  // Các đường dẫn dự phòng
  const fallbacks = [
    `https://csdltau.cangvuhaiphong.gov.vn/ship_plan.aspx?d=${dNum}`,
    `https://csdltau.cangvuhaiphong.gov.vn/ship_plan.aspx`,
    `http://csdltau.cangvuhaiphong.gov.vn/ship_plan.aspx?d=${dNum}`
  ];
  fallbacks.forEach(u => {
    if (!candidates.includes(u)) candidates.push(u);
  });

  // Bước 2: Thử lần lượt từng URL ứng viên (dừng sớm trước mốc 12.5s để không chạm timeout 15s của Vercel)
  if (!foundHtml) {
    for (const u of candidates) {
      if (Date.now() - startedAt > 12500) break;
      const r = await fetchWithTimeout(u, headers, 5000);
      tried.push({ url: u, status: r.status, error: r.error || null });
      if (r.ok && r.text && (/TD_ShowShipPlan/i.test(r.text) || /Kế\s*hoạch\s*tàu/i.test(r.text))) {
        foundHtml = r.text;
        foundUrl = r.finalUrl;
        break;
      }
    }
  }

  if (!foundHtml) {
    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(502).json({
        ok: false,
        message: 'Không lấy được dữ liệu từ Cảng vụ Hải Phòng.',
        tried
      });
    }
    return res.status(502).send('Cang vu fetch failed: ' + JSON.stringify(tried));
  }

  if (format === 'json') {
    const parsed = parseShiftingTableFromHtml(foundHtml, dNum);
    const arrivals = parseInOutTableFromHtml(foundHtml, parsed.date, 'arrivals');
    const departures = parseInOutTableFromHtml(foundHtml, parsed.date, 'departures');

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).json({
      ok: true,
      source: 'vercel-api-cangvu',
      fetchedUrl: foundUrl,
      d: dNum,
      date: parsed.date,
      updatedAt: new Date().toISOString(),
      count: parsed.count,
      rows: parsed.rows,
      arrivalsCount: arrivals.length,
      departuresCount: departures.length,
      arrivals,
      departures
    });
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(foundHtml);
};
