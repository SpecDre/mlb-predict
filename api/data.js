// api/data.js — Server-side MLB prediction engine
// Fetches all data, runs models, returns complete JSON in one call
// Frontend makes ONE request and renders instantly

const MLB = 'https://statsapi.mlb.com/api/v1';
const YR = new Date().getFullYear();
const HIST = [YR, YR-1, YR-2, YR-3];
const YR_W = {[YR]:1.0,[YR-1]:.55,[YR-2]:.30,[YR-3]:.15};
const LG = {hrPA:.033,hr9:1.25,iso:.150,avg:.248,whip:1.28,h9:8.4,babip:.295,era:4.20,rpg:4.6};

const PF_HR={'Coors Field':1.38,'Great American Ball Park':1.18,'Yankee Stadium':1.15,'Guaranteed Rate Field':1.10,'Globe Life Field':1.08,'Wrigley Field':1.07,'Citizens Bank Park':1.07,'Fenway Park':1.05,'Minute Maid Park':1.04,'Target Field':1.03,'Nationals Park':1.02,'Chase Field':1.02,'Truist Park':1.01,'Busch Stadium':1.00,'American Family Field':1.00,'Rogers Centre':.99,'Angel Stadium':.98,'Comerica Park':.97,'PNC Park':.97,'Progressive Field':.96,'Kauffman Stadium':.95,'Tropicana Field':.95,'loanDepot park':.94,'T-Mobile Park':.93,'Dodger Stadium':.93,'Citi Field':.92,'Oracle Park':.88,'Petco Park':.90,'Oakland Coliseum':.87,'Oriole Park at Camden Yards':1.06};
const PF_HIT={'Coors Field':1.12,'Fenway Park':1.06,'Globe Life Field':1.04,'Guaranteed Rate Field':1.03,'Wrigley Field':1.03,'Yankee Stadium':1.02,'Chase Field':1.02,'Citizens Bank Park':1.02,'Great American Ball Park':1.02,'Minute Maid Park':1.01,'Target Field':1.01,'Truist Park':1.01,'Rogers Centre':1.01,'Nationals Park':1.00,'Busch Stadium':1.00,'American Family Field':1.00,'PNC Park':1.00,'Angel Stadium':.99,'Oriole Park at Camden Yards':.99,'Comerica Park':.99,'Progressive Field':.99,'Kauffman Stadium':.98,'Tropicana Field':.98,'loanDepot park':.98,'Dodger Stadium':.97,'Citi Field':.97,'T-Mobile Park':.97,'Oracle Park':.96,'Petco Park':.96,'Oakland Coliseum':.95};
const PF_RUN={'Coors Field':1.25,'Great American Ball Park':1.12,'Yankee Stadium':1.08,'Globe Life Field':1.06,'Guaranteed Rate Field':1.06,'Fenway Park':1.05,'Wrigley Field':1.05,'Citizens Bank Park':1.05,'Chase Field':1.04,'Minute Maid Park':1.03,'Target Field':1.02,'Truist Park':1.01,'Nationals Park':1.01,'Rogers Centre':1.01,'American Family Field':1.00,'Busch Stadium':1.00,'Oriole Park at Camden Yards':1.00,'PNC Park':.99,'Angel Stadium':.98,'Progressive Field':.98,'Comerica Park':.97,'Kauffman Stadium':.97,'Tropicana Field':.96,'loanDepot park':.96,'Dodger Stadium':.96,'Citi Field':.95,'T-Mobile Park':.94,'Oracle Park':.93,'Petco Park':.94,'Oakland Coliseum':.93};

function gpf(v, t) {
  var m = t === 'hr' ? PF_HR : t === 'hit' ? PF_HIT : PF_RUN;
  if (!v) return 1;
  for (var k in m) { if (v.includes(k) || k.includes(v)) return m[k]; }
  return 1;
}

async function fetchJSON(url) {
  try {
    var r = await fetch(url, { headers: { 'User-Agent': 'MLBPredict/1.0' } });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

// Fetch multi-season stats with parallel requests
async function getMultiPitching(pid) {
  var results = await Promise.all(HIST.map(yr =>
    fetchJSON(MLB + '/people/' + pid + '/stats?stats=season&season=' + yr + '&group=pitching&gameType=R')
  ));
  var seasons = {};
  results.forEach(function(d, i) {
    var s = d && d.stats && d.stats[0] && d.stats[0].splits && d.stats[0].splits[0] && d.stats[0].splits[0].stat;
    if (s && parseFloat(s.inningsPitched || 0) > 0) seasons[HIST[i]] = s;
  });
  return seasons;
}

async function getMultiHitting(pid) {
  var results = await Promise.all(HIST.map(yr =>
    fetchJSON(MLB + '/people/' + pid + '/stats?stats=season&season=' + yr + '&group=hitting&gameType=R')
  ));
  var seasons = {};
  results.forEach(function(d, i) {
    var s = d && d.stats && d.stats[0] && d.stats[0].splits && d.stats[0].splits[0] && d.stats[0].splits[0].stat;
    if (s && (s.atBats || 0) > 0) seasons[HIST[i]] = s;
  });
  return seasons;
}

async function getH2H(bid, pid) {
  var results = await Promise.all(HIST.map(yr =>
    fetchJSON(MLB + '/people/' + bid + '/stats?stats=vsPlayer&opposingPlayerId=' + pid + '&season=' + yr + '&group=hitting&gameType=R')
  ));
  var t = { ab: 0, h: 0, hr: 0, bb: 0, so: 0, pa: 0 };
  results.forEach(function(d) {
    var s = d && d.stats && d.stats[0] && d.stats[0].splits && d.stats[0].splits[0] && d.stats[0].splits[0].stat;
    if (s) {
      t.ab += (s.atBats || 0); t.h += (s.hits || 0); t.hr += (s.homeRuns || 0);
      t.bb += (s.baseOnBalls || 0); t.so += (s.strikeOuts || 0);
      t.pa += (s.atBats || 0) + (s.baseOnBalls || 0) + (s.hitByPitch || 0) + (s.sacFlies || 0);
    }
  });
  if (t.pa < 3) return null;
  t.avg = t.ab > 0 ? t.h / t.ab : 0;
  t.hrRate = t.pa > 0 ? t.hr / t.pa : 0;
  return t;
}

function weightPit(seasons) {
  var wE = 0, wW = 0, wHR = 0, wH = 0, wTot = 0;
  var yrs = [];
  for (var yr in seasons) {
    var s = seasons[yr];
    var w = YR_W[yr] || .1;
    var ip = parseFloat(s.inningsPitched) || 0;
    if (ip < 10) continue;
    var sw = Math.min(ip / 150, 1);
    var fw = w * sw;
    wE += (parseFloat(s.era) || LG.era) * fw;
    wW += (parseFloat(s.whip) || LG.whip) * fw;
    wHR += (parseFloat(s.homeRunsPer9) || LG.hr9) * fw;
    wH += (parseFloat(s.hitsPer9) || LG.h9) * fw;
    wTot += fw;
    yrs.push({ yr: yr, ip: s.inningsPitched || '0', era: s.era || '-', whip: s.whip || '-' });
  }
  if (wTot === 0) return null;
  return { era: wE / wTot, whip: wW / wTot, hr9: wHR / wTot, h9: wH / wTot, yrs: yrs };
}

function weightBat(seasons) {
  var wHR = 0, wH = 0, wSLG = 0, wOBP = 0, wSO = 0, wTot = 0;
  var yrs = [];
  for (var yr in seasons) {
    var s = seasons[yr];
    var w = YR_W[yr] || .1;
    var ab = s.atBats || 0;
    var pa = ab + (s.baseOnBalls || 0) + (s.hitByPitch || 0) + (s.sacFlies || 0);
    if (pa < 10) continue;
    var sw = Math.min(pa / 400, 1);
    var fw = w * sw;
    wHR += ((s.homeRuns || 0) / Math.max(pa, 1)) * fw;
    wH += (ab > 0 ? (s.hits || 0) / ab : 0) * fw;
    wSLG += (parseFloat(s.slg) || 0) * fw;
    wOBP += (parseFloat(s.obp) || 0) * fw;
    wSO += (pa > 0 ? (s.strikeOuts || 0) / pa : 0) * fw;
    wTot += fw;
    yrs.push({ yr: yr, ab: ab, hr: s.homeRuns || 0, avg: s.avg || '-', ops: s.ops || '-' });
  }
  if (wTot === 0) return null;
  var avg = wH / wTot, slg = wSLG / wTot, obp = wOBP / wTot;
  var tHR = 0, tAB = 0;
  for (var y in seasons) { tHR += (seasons[y].homeRuns || 0); tAB += (seasons[y].atBats || 0); }
  return { hrPA: wHR / wTot, avg: avg, slg: slg, obp: obp, iso: slg - avg, kRate: wSO / wTot, babip: Math.max(.25, Math.min(.36, avg + .05)), totHR: tHR, totAB: tAB, yrs: yrs };
}

function calcHR(b, opp, pf, h2h) {
  var base = b.hrPA;
  var isoF = b.iso > 0 ? (b.iso / LG.iso) * .3 + .7 : 1;
  var pitF = 1;
  if (opp) { pitF = Math.max(.5, Math.min(1.5, opp.hr9 > 0 ? opp.hr9 / LG.hr9 : opp.era / LG.era)); }
  var h2hF = 1;
  if (h2h && h2h.pa >= 5 && h2h.hrRate > 0) { h2hF = Math.max(.8, Math.min(1.4, 1 + (h2h.hrRate / LG.hrPA - 1) * .3)); }
  var pp = Math.max(.005, Math.min(.08, base * isoF * pitF * (pf || 1) * h2hF));
  var gm = 1 - Math.pow(1 - pp, 3.8);
  gm = Math.min(gm, .20);
  return { pct: (gm * 100).toFixed(1), f: { base: (base * 100).toFixed(2), iso: isoF.toFixed(2), pitcher: pitF.toFixed(2), park: (pf || 1).toFixed(2), h2h: h2hF.toFixed(2) } };
}

function calcHit(b, opp, pf, h2h) {
  var base = b.avg;
  var cF = b.babip > 0 ? (b.babip / LG.babip) * .25 + .75 : 1;
  var pitF = 1;
  if (opp) { if (opp.h9 > 0) pitF = opp.h9 / LG.h9; else if (opp.whip > 0) pitF = opp.whip / LG.whip; }
  var dF = 1;
  if (b.obp > 0) { dF = Math.max(.80, Math.min(1.25, (1 + (b.obp - .320) * .5) * (1 + (.22 - b.kRate) * .3))); }
  var h2hF = 1;
  if (h2h && h2h.pa >= 5 && h2h.ab >= 3 && h2h.avg > 0) { h2hF = Math.max(.75, Math.min(1.5, 1 + (h2h.avg / LG.avg - 1) * .35)); }
  var pp = Math.max(.10, Math.min(.45, base * cF * pitF * (pf || 1) * dF * h2hF));
  var gm = 1 - Math.pow(1 - pp, 3.8);
  return { pct: (gm * 100).toFixed(1), f: { base: (base * 1000).toFixed(0), contact: cF.toFixed(2), pitcher: pitF.toFixed(2), park: (pf || 1).toFixed(2), disc: dF.toFixed(2), h2h: h2hF.toFixed(2) } };
}

function calcWin(a, h, aP, hP, venue) {
  var rpf = gpf(venue, 'run');
  var aW = a.gp >= 30 ? a.wp : a.wp * (a.gp / 40) + .5 * (1 - a.gp / 40);
  var hW = h.gp >= 30 ? h.wp : h.wp * (h.gp / 40) + .5 * (1 - h.gp / 40);
  var aE = aP ? aP.era : LG.era, hE = hP ? hP.era : LG.era;
  var aSF = LG.era / Math.max(aE, 1.5), hSF = LG.era / Math.max(hE, 1.5);
  var tot = (aW - hW) * .8 + (aSF - hSF) * .25 + (a.ops - h.ops) * .3 + ((a.l10 || .5) - (h.l10 || .5)) * .5 + (a.rdPG - h.rdPG) * .04 - .04;
  var awP = 1 / (1 + Math.exp(-tot * 4));
  var bR = LG.rpg * rpf;
  return {
    aProb: Math.round(awP * 100), hProb: Math.round((1 - awP) * 100),
    aRuns: Math.max(1, Math.round(bR * (a.ops / .72) * hSF * 10) / 10),
    hRuns: Math.max(1, Math.round(bR * (h.ops / .72) * aSF * 10) / 10),
    det: { aERA: aE.toFixed(2), hERA: hE.toFixed(2) }
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');

  var date = req.query.date || new Date().toISOString().slice(0, 10);

  try {
    // Step 1: Schedule + Standings in parallel
    var [schedData, standData] = await Promise.all([
      fetchJSON(MLB + '/schedule?sportId=1&date=' + date + '&hydrate=probablePitcher(note),team,linescore,venue'),
      fetchJSON(MLB + '/standings?leagueId=103,104&season=' + YR + '&standingsTypes=regularSeason&hydrate=team')
    ]);

    // Also try last year's standings as fallback
    var standDataPrev = await fetchJSON(MLB + '/standings?leagueId=103,104&season=' + (YR - 1) + '&standingsTypes=regularSeason&hydrate=team');

    var games = (schedData && schedData.dates && schedData.dates[0] && schedData.dates[0].games) || [];
    if (games.length === 0) {
      return res.status(200).json({ date: date, games: [], batters: [], gamePreds: [], noGames: true });
    }

    // Parse standings
    var standings = {};
    [standData, standDataPrev].forEach(function(sd) {
      if (!sd || !sd.records) return;
      sd.records.forEach(function(rec) {
        (rec.teamRecords || []).forEach(function(tr) {
          var tid = tr.team && tr.team.id;
          if (!tid || (standings[tid] && standings[tid].yr === YR)) return;
          var l10 = (tr.records && tr.records.splitRecords || []).find(function(s) { return s.type === 'lastTen'; });
          standings[tid] = {
            wins: tr.wins || 0, losses: tr.losses || 0, pct: parseFloat(tr.winningPercentage) || .5,
            rd: tr.runDifferential || 0, gp: (tr.wins || 0) + (tr.losses || 0),
            l10w: l10 && l10.wins, l10l: l10 && l10.losses,
            streak: tr.streak && tr.streak.streakCode || '', yr: sd === standData ? YR : YR - 1
          };
        });
      });
    });

    // Step 2: Get unique team IDs and fetch team batting in parallel
    var teamIds = new Set();
    games.forEach(function(g) { teamIds.add(g.teams.away.team.id); teamIds.add(g.teams.home.team.id); });
    var teamBatPromises = [];
    teamIds.forEach(function(tid) {
      teamBatPromises.push(
        fetchJSON(MLB + '/teams/' + tid + '/stats?stats=season&season=' + YR + '&group=hitting&gameType=R')
          .then(function(d) { return { tid: tid, yr: YR, stat: d && d.stats && d.stats[0] && d.stats[0].splits && d.stats[0].splits[0] && d.stats[0].splits[0].stat }; })
      );
      teamBatPromises.push(
        fetchJSON(MLB + '/teams/' + tid + '/stats?stats=season&season=' + (YR - 1) + '&group=hitting&gameType=R')
          .then(function(d) { return { tid: tid, yr: YR - 1, stat: d && d.stats && d.stats[0] && d.stats[0].splits && d.stats[0].splits[0] && d.stats[0].splits[0].stat }; })
      );
    });
    var teamBatResults = await Promise.all(teamBatPromises);
    var teamBat = {};
    teamBatResults.forEach(function(r) {
      if (r.stat && (r.stat.atBats || 0) > 100 && (!teamBat[r.tid] || r.yr === YR)) {
        teamBat[r.tid] = { ops: parseFloat(r.stat.ops) || .720 };
      }
    });

    // Step 3: Fetch all pitcher stats + boxscores in parallel
    var pitcherIds = new Set();
    games.forEach(function(g) {
      if (g.teams.away.probablePitcher) pitcherIds.add(g.teams.away.probablePitcher.id);
      if (g.teams.home.probablePitcher) pitcherIds.add(g.teams.home.probablePitcher.id);
    });

    var pitcherPromises = [];
    pitcherIds.forEach(function(pid) {
      pitcherPromises.push(getMultiPitching(pid).then(function(s) { return { pid: pid, seasons: s }; }));
    });

    var boxPromises = games.map(function(g) {
      return fetchJSON(MLB + '/game/' + g.gamePk + '/boxscore').then(function(b) { return { pk: g.gamePk, box: b }; });
    });

    var [pitcherResults, boxResults] = await Promise.all([
      Promise.all(pitcherPromises),
      Promise.all(boxPromises)
    ]);

    var pitcherStats = {};
    pitcherResults.forEach(function(r) { pitcherStats[r.pid] = weightPit(r.seasons); });

    var boxscores = {};
    boxResults.forEach(function(r) { boxscores[r.pk] = r.box; });

    // Step 4: Process each game — compute game predictions + collect batter IDs
    var gamePreds = [];
    var allBatterJobs = []; // { pid, side, gamePk, oppPitcher, oppPitcherId, team }

    games.forEach(function(g) {
      var aw = g.teams.away.team, ho = g.teams.home.team;
      var venue = g.venue && g.venue.name || '';
      var apId = g.teams.away.probablePitcher && g.teams.away.probablePitcher.id;
      var hpId = g.teams.home.probablePitcher && g.teams.home.probablePitcher.id;
      var apW = pitcherStats[apId] || null;
      var hpW = pitcherStats[hpId] || null;
      var aSt = standings[aw.id] || { wins: 81, losses: 81, pct: .5, rd: 0, gp: 162 };
      var hSt = standings[ho.id] || { wins: 81, losses: 81, pct: .5, rd: 0, gp: 162 };

      var pred = calcWin(
        { abbr: aw.abbreviation, wp: aSt.pct, ops: (teamBat[aw.id] || { ops: .72 }).ops, l10: aSt.l10w ? aSt.l10w / 10 : .5, rdPG: aSt.gp > 0 ? aSt.rd / aSt.gp : 0, gp: aSt.gp },
        { abbr: ho.abbreviation, wp: hSt.pct, ops: (teamBat[ho.id] || { ops: .72 }).ops, l10: hSt.l10w ? hSt.l10w / 10 : .5, rdPG: hSt.gp > 0 ? hSt.rd / hSt.gp : 0, gp: hSt.gp },
        apW, hpW, venue
      );

      var gp = {
        gamePk: g.gamePk, away: aw.abbreviation, home: ho.abbreviation,
        awayName: aw.name, homeName: ho.name, venue: venue,
        gameDate: g.gameDate, status: g.status && g.status.abstractGameState,
        awaySP: g.teams.away.probablePitcher && g.teams.away.probablePitcher.fullName || 'TBD',
        homeSP: g.teams.home.probablePitcher && g.teams.home.probablePitcher.fullName || 'TBD',
        aRec: aSt.wins + '-' + aSt.losses, hRec: hSt.wins + '-' + hSt.losses,
        aPitYrs: apW ? apW.yrs : [], hPitYrs: hpW ? hpW.yrs : [],
        pred: pred
      };
      gamePreds.push(gp);

      // Collect batters from boxscore
      var box = boxscores[g.gamePk];
      if (box && box.teams) {
        ['away', 'home'].forEach(function(side) {
          var td = box.teams[side];
          if (!td) return;
          var order = (td.battingOrder || []).slice(0, 9);
          var players = td.players || {};
          order.forEach(function(pid) {
            var p = players['ID' + pid];
            if (!p) return;
            allBatterJobs.push({
              pid: pid, side: side, gamePk: g.gamePk,
              name: p.person && p.person.fullName || 'Unknown',
              pos: p.position && p.position.abbreviation || '',
              team: side === 'away' ? aw.abbreviation : ho.abbreviation,
              oppPW: side === 'away' ? hpW : apW,
              oppPId: side === 'away' ? hpId : apId,
              oppPName: side === 'away' ? gp.homeSP : gp.awaySP,
              venue: venue,
              gameStats: p.stats && p.stats.batting ? {
                ab: p.stats.batting.atBats || 0,
                h: p.stats.batting.hits || 0,
                hr: p.stats.batting.homeRuns || 0,
                rbi: p.stats.batting.rbi || 0,
                bb: p.stats.batting.baseOnBalls || 0,
                so: p.stats.batting.strikeOuts || 0
              } : null
            });
          });
        });
      }
    });

    // Step 5: Fetch all batter stats in parallel (batched)
    var BATCH = 10;
    var allBatters = [];

    for (var i = 0; i < allBatterJobs.length; i += BATCH) {
      var batch = allBatterJobs.slice(i, i + BATCH);
      var batchResults = await Promise.all(batch.map(function(job) {
        return Promise.all([
          getMultiHitting(job.pid),
          job.oppPId ? getH2H(job.pid, job.oppPId) : Promise.resolve(null)
        ]).then(function(results) {
          return { job: job, seasons: results[0], h2h: results[1] };
        });
      }));

      batchResults.forEach(function(r) {
        var bW = weightBat(r.seasons);
        if (!bW) return;
        var job = r.job;
        var pfHR = gpf(job.venue, 'hr');
        var pfHit = gpf(job.venue, 'hit');
        var hrR = calcHR(bW, job.oppPW, pfHR, r.h2h);
        var hitR = calcHit(bW, job.oppPW, pfHit, r.h2h);

        allBatters.push({
          id: job.pid, name: job.name, team: job.team, side: job.side,
          pos: job.pos, gamePk: job.gamePk,
          avg: bW.avg, slg: bW.slg, obp: bW.obp, iso: bW.iso,
          totHR: bW.totHR, totAB: bW.totAB, yrs: bW.yrs,
          hrPct: hrR.pct, hrF: hrR.f,
          hitPct: hitR.pct, hitF: hitR.f,
          h2h: r.h2h, oppP: job.oppPName,
          gs: job.gameStats
        });
      });
    }

    return res.status(200).json({
      date: date,
      games: games.map(function(g) {
        return {
          gamePk: g.gamePk, gameDate: g.gameDate,
          status: g.status, venue: g.venue,
          teams: { away: g.teams.away, home: g.teams.home },
          linescore: g.linescore || null
        };
      }),
      gamePreds: gamePreds,
      batters: allBatters,
      meta: { gamesCount: games.length, battersCount: allBatters.length, generatedAt: new Date().toISOString() }
    });

  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
};
