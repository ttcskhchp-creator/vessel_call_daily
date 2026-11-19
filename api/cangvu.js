module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate');

  const d = (req.query && req.query.d !== undefined) ? req.query.d : '0';
  const targetUrl = `https://csdltau.cangvuhaiphong.gov.vn/ship_plan.aspx?d=${encodeURIComponent(d)}`;

  try {
    const response = await fetch(targetUrl, {
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
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (err) {
    return res.status(500).send('Server Error: ' + err.message);
  }
};
