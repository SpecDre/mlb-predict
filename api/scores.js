// api/scores.js — Enhanced live scores
// Called every 10 seconds. For live games, fetches rich game data.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=10');
  var date = req.query.date || new Date().toISOString().slice(0, 10);

  try {
    // Step 1: Get schedule with linescore
    var schedResp = await fetch(
      'https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=' + date + '&hydrate=linescore',
      { headers: { 'User-Agent': 'MLBPredict/1.0' } }
    );
    if (!schedResp.ok) return res.status(schedResp.status).json({ error: 'MLB API ' + schedResp.status });
    var schedData = await schedResp.json();
    var games = (schedData.dates && schedData.dates[0] && schedData.dates[0].games) || [];

    // Step 2: For live games, fetch full game feed in parallel
    var liveGamePks = games.filter(function(g) {
      return g.status && g.status.abstractGameState === 'Live';
    }).map(function(g) { return g.gamePk; });

    var feedMap = {};
    if (liveGamePks.length > 0) {
      var feedResults = await Promise.all(liveGamePks.map(function(pk) {
        return fetch('https://statsapi.mlb.com/api/v1.1/game/' + pk + '/feed/live', {
          headers: { 'User-Agent': 'MLBPredict/1.0' }
        }).then(function(r) { return r.ok ? r.json() : null; }).catch(function() { return null; });
      }));
      liveGamePks.forEach(function(pk, i) { feedMap[pk] = feedResults[i]; });
    }

    // Also fetch feeds for Final games to get scoring plays
    var finalGamePks = games.filter(function(g) {
      return g.status && g.status.abstractGameState === 'Final';
    }).map(function(g) { return g.gamePk; });

    if (finalGamePks.length > 0) {
      var finalResults = await Promise.all(finalGamePks.map(function(pk) {
        return fetch('https://statsapi.mlb.com/api/v1.1/game/' + pk + '/feed/live', {
          headers: { 'User-Agent': 'MLBPredict/1.0' }
        }).then(function(r) { return r.ok ? r.json() : null; }).catch(function() { return null; });
      }));
      finalGamePks.forEach(function(pk, i) { feedMap[pk] = finalResults[i]; });
    }

    var scores = games.map(function(g) {
      var ls = g.linescore || {};
      var feed = feedMap[g.gamePk];
      var isLive = g.status && g.status.abstractGameState === 'Live';
      var isFinal = g.status && g.status.abstractGameState === 'Final';

      // Per-inning runs
      var innings = [];
      if (ls.innings) {
        innings = ls.innings.map(function(inn) {
          return { num: inn.num, away: inn.away ? inn.away.runs : null, home: inn.home ? inn.home.runs : null };
        });
      }

      // Current matchup from feed
      var currentBatter = null;
      var currentPitcher = null;
      var lastPlay = null;
      var scoringPlays = [];
      var awayPitchCount = 0;
      var homePitchCount = 0;

      if (feed) {
        var ld = feed.liveData;

        // Current play
        if (ld && ld.plays) {
          var cp = ld.plays.currentPlay;
          if (cp) {
            // Current matchup
            if (cp.matchup) {
              if (cp.matchup.batter) {
                currentBatter = {
                  name: cp.matchup.batter.fullName,
                  id: cp.matchup.batter.id
                };
              }
              if (cp.matchup.pitcher) {
                currentPitcher = {
                  name: cp.matchup.pitcher.fullName,
                  id: cp.matchup.pitcher.id
                };
              }
            }
          }

          // Last completed play description
          var allPlays = ld.plays.allPlays || [];
          for (var i = allPlays.length - 1; i >= 0; i--) {
            var p = allPlays[i];
            if (p.result && p.result.description && p.result.type !== 'atBat' || p.result && p.result.description) {
              lastPlay = {
                desc: p.result.description,
                event: p.result.event || '',
                inning: p.about ? (p.about.isTopInning ? 'Top' : 'Bot') + ' ' + (p.about.inning || '') : ''
              };
              break;
            }
          }

          // Scoring plays
          var spIdx = ld.plays.scoringPlays || [];
          spIdx.forEach(function(idx) {
            var sp = allPlays[idx];
            if (sp && sp.result) {
              scoringPlays.push({
                desc: sp.result.description,
                event: sp.result.event || '',
                inning: sp.about ? (sp.about.isTopInning ? 'Top' : 'Bot') + ' ' + (sp.about.inning || '') : '',
                awayScore: sp.result.awayScore || 0,
                homeScore: sp.result.homeScore || 0
              });
            }
          });
        }

        // Pitch counts from boxscore
        if (ld && ld.boxscore && ld.boxscore.teams) {
          var extractPitchCount = function(teamData) {
            if (!teamData || !teamData.pitchers || !teamData.players) return 0;
            // First pitcher in the list is the starter
            var starterId = teamData.pitchers && teamData.pitchers[0];
            if (starterId) {
              var sp = teamData.players['ID' + starterId];
              if (sp && sp.stats && sp.stats.pitching) {
                return sp.stats.pitching.numberOfPitches || 0;
              }
            }
            return 0;
          };
          awayPitchCount = extractPitchCount(ld.boxscore.teams.away);
          homePitchCount = extractPitchCount(ld.boxscore.teams.home);
        }

        // Batter/pitcher season stats from boxscore
        if (currentBatter && ld && ld.boxscore && ld.boxscore.teams) {
          var findPlayer = function(teams, pid) {
            var sides = ['away', 'home'];
            for (var s = 0; s < sides.length; s++) {
              var t = teams[sides[s]];
              if (t && t.players && t.players['ID' + pid]) {
                var p = t.players['ID' + pid];
                if (p.seasonStats && p.seasonStats.batting) {
                  return p.seasonStats.batting;
                }
              }
            }
            return null;
          };
          var bs = findPlayer(ld.boxscore.teams, currentBatter.id);
          if (bs) {
            currentBatter.avg = bs.avg || '-';
            currentBatter.hr = bs.homeRuns || 0;
            currentBatter.rbi = bs.rbi || 0;
            currentBatter.ops = bs.ops || '-';
          }
          // Today's game stats
          var findGameStats = function(teams, pid) {
            var sides = ['away', 'home'];
            for (var s = 0; s < sides.length; s++) {
              var t = teams[sides[s]];
              if (t && t.players && t.players['ID' + pid]) {
                var p = t.players['ID' + pid];
                if (p.stats && p.stats.batting) {
                  return p.stats.batting;
                }
              }
            }
            return null;
          };
          var bg = findGameStats(ld.boxscore.teams, currentBatter.id);
          if (bg) {
            currentBatter.todayAB = bg.atBats || 0;
            currentBatter.todayH = bg.hits || 0;
            currentBatter.todayHR = bg.homeRuns || 0;
          }
        }
        if (currentPitcher && ld && ld.boxscore && ld.boxscore.teams) {
          var findPitcher = function(teams, pid) {
            var sides = ['away', 'home'];
            for (var s = 0; s < sides.length; s++) {
              var t = teams[sides[s]];
              if (t && t.players && t.players['ID' + pid]) {
                var p = t.players['ID' + pid];
                return {
                  season: p.seasonStats && p.seasonStats.pitching || null,
                  game: p.stats && p.stats.pitching || null
                };
              }
            }
            return null;
          };
          var ps = findPitcher(ld.boxscore.teams, currentPitcher.id);
          if (ps) {
            if (ps.season) {
              currentPitcher.era = ps.season.era || '-';
              currentPitcher.wins = ps.season.wins || 0;
              currentPitcher.losses = ps.season.losses || 0;
            }
            if (ps.game) {
              currentPitcher.todayIP = ps.game.inningsPitched || '0';
              currentPitcher.todayK = ps.game.strikeOuts || 0;
              currentPitcher.todayH = ps.game.hits || 0;
              currentPitcher.todayR = ps.game.runs || 0;
              currentPitcher.todayPC = ps.game.numberOfPitches || 0;
            }
          }
        }
      }

      return {
        gamePk: g.gamePk,
        status: g.status ? g.status.abstractGameState : 'Preview',
        detailedState: g.status ? g.status.detailedState : '',
        inning: ls.currentInning || 0,
        inningHalf: ls.inningHalf || '',
        isTopInning: ls.isTopInning || false,
        awayScore: (g.teams && g.teams.away && g.teams.away.score) || 0,
        homeScore: (g.teams && g.teams.home && g.teams.home.score) || 0,
        awayHits: ls.teams && ls.teams.away ? ls.teams.away.hits || 0 : 0,
        homeHits: ls.teams && ls.teams.home ? ls.teams.home.hits || 0 : 0,
        awayErrors: ls.teams && ls.teams.away ? ls.teams.away.errors || 0 : 0,
        homeErrors: ls.teams && ls.teams.home ? ls.teams.home.errors || 0 : 0,
        outs: ls.outs || 0,
        innings: innings,
        currentBatter: currentBatter,
        currentPitcher: currentPitcher,
        lastPlay: lastPlay,
        scoringPlays: scoringPlays,
        awayPitchCount: awayPitchCount,
        homePitchCount: homePitchCount
      };
    });

    return res.status(200).json({ date: date, scores: scores, ts: Date.now() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
