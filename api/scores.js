module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=10');
  var date = req.query.date || new Date().toISOString().slice(0, 10);
  try {
    var r = await fetch(
      'https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=' + date + '&hydrate=linescore',
      { headers: { 'User-Agent': 'MLBPredict/1.0' } }
    );
    if (!r.ok) return res.status(r.status).json({ error: 'MLB API ' + r.status });
    var data = await r.json();
    var games = (data.dates && data.dates[0] && data.dates[0].games) || [];
    var scores = games.map(function(g) {
      var ls = g.linescore || {};
      return {
        gamePk: g.gamePk,
        status: g.status ? g.status.abstractGameState : 'Preview',
        detailedState: g.status ? g.status.detailedState : '',
        inning: ls.currentInning || 0,
        inningHalf: ls.inningHalf || '',
        isTopInning: ls.isTopInning || false,
        awayScore: (g.teams && g.teams.away && g.teams.away.score) || 0,
        homeScore: (g.teams && g.teams.home && g.teams.home.score) || 0,
        outs: ls.outs || 0
      };
    });
    return res.status(200).json({ date: date, scores: scores, ts: Date.now() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
