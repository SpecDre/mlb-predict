module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');

  const { path } = req.query;
  if (!path || path.length === 0) {
    return res.status(400).json({ error: 'No path provided' });
  }

  const mlbPath = '/' + (Array.isArray(path) ? path.join('/') : path);

  const queryParams = { ...req.query };
  delete queryParams.path;
  const qs = Object.keys(queryParams).length > 0
    ? '?' + new URLSearchParams(queryParams).toString()
    : '';

  const url = 'https://statsapi.mlb.com' + mlbPath + qs;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'MLBPredict/1.0',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: 'MLB API returned ' + response.status,
        url: mlbPath + qs,
      });
    }

    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
