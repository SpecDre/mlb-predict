module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');

  var mlbpath = req.query.mlbpath || '/api/v1/schedule';
  var queryParams = Object.assign({}, req.query);
  delete queryParams.mlbpath;
  var qs = Object.keys(queryParams).length > 0
    ? '?' + new URLSearchParams(queryParams).toString()
    : '';

  var url = 'https://statsapi.mlb.com' + mlbpath + qs;

  try {
    var response = await fetch(url, {
      headers: { 'User-Agent': 'MLBPredict/1.0', 'Accept': 'application/json' }
    });
    if (!response.ok) {
      return res.status(response.status).json({ error: 'MLB API ' + response.status, url: url });
    }
    var data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message, url: url });
  }
};
