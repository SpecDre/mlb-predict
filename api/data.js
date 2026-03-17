// api/data.js — MLB Predict v3: Full prediction engine
// v2: Pythagorean wins, platoon splits, Statcast barrel/EV, calibrated model
// v3: Weather (temp+wind), fly ball rate, bullpen HR/9, lineup position, dynamic HR cap
// All data fetched server-side, one JSON response to frontend

const MLB = 'https://statsapi.mlb.com/api/v1';
const SAVANT = 'https://baseballsavant.mlb.com';
const YR = new Date().getFullYear();
const HIST = [YR, YR-1, YR-2, YR-3];
const YR_W = {[YR]:1.0, [YR-1]:.55, [YR-2]:.30, [YR-3]:.15};
const PYTH_EXP = 1.83; // Pythagorean exponent (Pythagenpat)

// League averages (2024 baseline)
const LG = {
  hrPA:.033, hr9:1.25, iso:.150, avg:.248, whip:1.28, h9:8.4, babip:.295,
  era:4.20, rpg:4.6, ops:.720, slg:.400, obp:.320,
  barrelPct:8.5, exitVelo:88.5, xHR:.033,
  fbPct:53.0, bullpenHR9:1.15  // fbPct calibrated to airOuts/(airOuts+groundOuts), not true FB%
};

// --- Weather factor for HR probability ---
// Warmer temps = more carry; wind out = HR boost; wind in = HR suppression
function calcWeatherFactor(weather) {
  if (!weather) return { temp: 1, wind: 1, combined: 1 };
  var tempF = 1;
  var temp = parseInt(weather.temp) || 72;
  // Every 10°F above 72 adds ~3% HR probability, below subtracts
  tempF = Math.max(.88, Math.min(1.12, 1 + (temp - 72) * .003));

  var windF = 1;
  var windSpeed = parseInt(weather.wind) || 0;
  var windDir = (weather.wind || '').toLowerCase();
  if (windSpeed >= 5) {
    if (windDir.includes('out to')) {
      // Only "Out To CF/LF/RF" is truly blowing out
      windF = Math.min(1.15, 1 + windSpeed * .008);
    } else if (windDir.includes('in from')) {
      // "In From" = blowing in, suppresses HRs
      windF = Math.max(.85, 1 - windSpeed * .008);
    }
    // "L To R", "R To L", "Varies", calm = crosswind/neutral, no effect
  }
  return { temp: +tempF.toFixed(3), wind: +windF.toFixed(3), combined: +(tempF * windF).toFixed(3) };
}

// Park factors
const PF_HR={'Coors Field':1.38,'Great American Ball Park':1.18,'Yankee Stadium':1.15,'Guaranteed Rate Field':1.10,'Globe Life Field':1.08,'Wrigley Field':1.07,'Citizens Bank Park':1.07,'Fenway Park':1.05,'Minute Maid Park':1.04,'Target Field':1.03,'Nationals Park':1.02,'Chase Field':1.02,'Truist Park':1.01,'Busch Stadium':1.00,'American Family Field':1.00,'Rogers Centre':.99,'Angel Stadium':.98,'Comerica Park':.97,'PNC Park':.97,'Progressive Field':.96,'Kauffman Stadium':.95,'Tropicana Field':.95,'loanDepot park':.94,'T-Mobile Park':.93,'Dodger Stadium':.93,'Citi Field':.92,'Oracle Park':.88,'Petco Park':.90,'Oakland Coliseum':.87,'Oriole Park at Camden Yards':1.06};
const PF_HIT={'Coors Field':1.12,'Fenway Park':1.06,'Globe Life Field':1.04,'Guaranteed Rate Field':1.03,'Wrigley Field':1.03,'Yankee Stadium':1.02,'Chase Field':1.02,'Citizens Bank Park':1.02,'Great American Ball Park':1.02,'Minute Maid Park':1.01,'Target Field':1.01,'Truist Park':1.01,'Rogers Centre':1.01,'Nationals Park':1.00,'Busch Stadium':1.00,'American Family Field':1.00,'PNC Park':1.00,'Angel Stadium':.99,'Oriole Park at Camden Yards':.99,'Comerica Park':.99,'Progressive Field':.99,'Kauffman Stadium':.98,'Tropicana Field':.98,'loanDepot park':.98,'Dodger Stadium':.97,'Citi Field':.97,'T-Mobile Park':.97,'Oracle Park':.96,'Petco Park':.96,'Oakland Coliseum':.95};
const PF_RUN={'Coors Field':1.25,'Great American Ball Park':1.12,'Yankee Stadium':1.08,'Globe Life Field':1.06,'Guaranteed Rate Field':1.06,'Fenway Park':1.05,'Wrigley Field':1.05,'Citizens Bank Park':1.05,'Chase Field':1.04,'Minute Maid Park':1.03,'Target Field':1.02,'Truist Park':1.01,'Nationals Park':1.01,'Rogers Centre':1.01,'American Family Field':1.00,'Busch Stadium':1.00,'Oriole Park at Camden Yards':1.00,'PNC Park':.99,'Angel Stadium':.98,'Progressive Field':.98,'Comerica Park':.97,'Kauffman Stadium':.97,'Tropicana Field':.96,'loanDepot park':.96,'Dodger Stadium':.96,'Citi Field':.95,'T-Mobile Park':.94,'Oracle Park':.93,'Petco Park':.94,'Oakland Coliseum':.93};

function gpf(v, t) {
  var m = t === 'hr' ? PF_HR : t === 'hit' ? PF_HIT : PF_RUN;
  if (!v) return 1;
  for (var k in m) { if (v.includes(k) || k.includes(v)) return m[k]; }
  return 1;
}

// --- Pythagorean expected win% ---
function pythagWin(rs, ra) {
  if (rs <= 0 && ra <= 0) return .5;
  if (ra <= 0) return .95;
  var rsE = Math.pow(rs, PYTH_EXP);
  var raE = Math.pow(ra, PYTH_EXP);
  return rsE / (rsE + raE);
}

// Compute RS/RA per game from run differential + league average
function computeRSRA(rd, gp) {
  if (gp <= 0) return { rs: LG.rpg, ra: LG.rpg };
  var rdPG = rd / gp;
  return { rs: Math.max(1, LG.rpg + rdPG / 2), ra: Math.max(1, LG.rpg - rdPG / 2) };
}

// --- API helpers ---
async function fetchJSON(url) {
  try {
    var r = await fetch(url, { headers: { 'User-Agent': 'MLBPredict/2.0' } });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

async function fetchText(url) {
  try {
    var r = await fetch(url, { headers: { 'User-Agent': 'MLBPredict/2.0', 'Accept': 'text/csv,text/plain,*/*' } });
    if (!r.ok) return null;
    return await r.text();
  } catch (e) { return null; }
}

// --- Statcast bulk fetch from Baseball Savant ---
async function fetchStatcast() {
  try {
    var years = [YR, YR - 1];
    for (var y = 0; y < years.length; y++) {
      var url = SAVANT + '/leaderboard/expected_statistics?type=batter&year=' + years[y] + '&position=&team=&min=25&csv=true';
      var csv = await fetchText(url);
      if (csv && csv.length > 200 && csv.includes('player_id')) {
        return parseStatcastCSV(csv, years[y]);
      }
    }
    return {};
  } catch (e) { return {}; }
}

function parseStatcastCSV(csv, year) {
  var lines = csv.trim().split('\n');
  if (lines.length < 2) return {};
  var headers = lines[0].split(',').map(function(h) { return h.trim().replace(/"/g, ''); });

  function findCol() {
    for (var i = 0; i < arguments.length; i++) {
      var idx = headers.indexOf(arguments[i]);
      if (idx >= 0) return idx;
    }
    return -1;
  }

  var idIdx = findCol('player_id');
  var brlIdx = findCol('brl_percent', 'barrel_batted_rate');
  var evIdx = findCol('exit_velocity_avg', 'avg_hit_speed');
  var xbaIdx = findCol('est_ba', 'xba');
  var xslgIdx = findCol('est_slg', 'xslg');
  var xwobaIdx = findCol('est_woba', 'xwoba');

  if (idIdx < 0) return {};

  var map = {};
  for (var i = 1; i < lines.length; i++) {
    var cols = lines[i].split(',').map(function(c) { return c.trim().replace(/"/g, ''); });
    var pid = parseInt(cols[idIdx]);
    if (!pid) continue;
    map[pid] = {
      barrelPct: brlIdx >= 0 ? parseFloat(cols[brlIdx]) || 0 : 0,
      exitVelo: evIdx >= 0 ? parseFloat(cols[evIdx]) || 0 : 0,
      xBA: xbaIdx >= 0 ? parseFloat(cols[xbaIdx]) || 0 : 0,
      xSLG: xslgIdx >= 0 ? parseFloat(cols[xslgIdx]) || 0 : 0,
      xwOBA: xwobaIdx >= 0 ? parseFloat(cols[xwobaIdx]) || 0 : 0,
      year: year
    };
  }
  return map;
}

// --- Pitcher handedness ---
async function fetchPitcherHand(pid) {
  var d = await fetchJSON(MLB + '/people/' + pid);
  if (d && d.people && d.people[0]) {
    var p = d.people[0];
    return p.pitchHand && p.pitchHand.code || 'R';
  }
  return 'R';
}

// --- Multi-season stat fetchers ---
async function getMultiPitching(pid) {
  var results = await Promise.all(HIST.map(function(yr) {
    return fetchJSON(MLB + '/people/' + pid + '/stats?stats=season&season=' + yr + '&group=pitching&gameType=R');
  }));
  var seasons = {};
  results.forEach(function(d, i) {
    var s = d && d.stats && d.stats[0] && d.stats[0].splits && d.stats[0].splits[0] && d.stats[0].splits[0].stat;
    if (s && parseFloat(s.inningsPitched || 0) > 0) seasons[HIST[i]] = s;
  });
  return seasons;
}

async function getMultiHitting(pid) {
  var results = await Promise.all(HIST.map(function(yr) {
    return fetchJSON(MLB + '/people/' + pid + '/stats?stats=season&season=' + yr + '&group=hitting&gameType=R');
  }));
  var seasons = {};
  results.forEach(function(d, i) {
    var s = d && d.stats && d.stats[0] && d.stats[0].splits && d.stats[0].splits[0] && d.stats[0].splits[0].stat;
    if (s && (s.atBats || 0) > 0) seasons[HIST[i]] = s;
  });
  return seasons;
}

// Fetch platoon splits (vs L or vs R) for current + last year
async function getPlatoonSplits(pid, vsHand) {
  var sitCode = vsHand === 'L' ? 'vl' : 'vr';
  var years = [YR, YR - 1];
  var results = await Promise.all(years.map(function(yr) {
    return fetchJSON(MLB + '/people/' + pid + '/stats?stats=season&season=' + yr + '&group=hitting&gameType=R&sitCodes=' + sitCode);
  }));
  var t = { ab: 0, h: 0, hr: 0, pa: 0, so: 0, doubles: 0, triples: 0 };
  results.forEach(function(d) {
    var s = d && d.stats && d.stats[0] && d.stats[0].splits && d.stats[0].splits[0] && d.stats[0].splits[0].stat;
    if (s) {
      t.ab += (s.atBats || 0);
      t.h += (s.hits || 0);
      t.hr += (s.homeRuns || 0);
      t.so += (s.strikeOuts || 0);
      t.doubles += (s.doubles || 0);
      t.triples += (s.triples || 0);
      t.pa += (s.atBats || 0) + (s.baseOnBalls || 0) + (s.hitByPitch || 0) + (s.sacFlies || 0);
    }
  });
  if (t.pa < 15) return null;
  var singles = t.h - t.doubles - t.triples - t.hr;
  var tb = singles + t.doubles * 2 + t.triples * 3 + t.hr * 4;
  return {
    avg: t.ab > 0 ? t.h / t.ab : 0,
    slg: t.ab > 0 ? tb / t.ab : 0,
    hrPA: t.pa > 0 ? t.hr / t.pa : 0,
    kRate: t.pa > 0 ? t.so / t.pa : 0,
    iso: t.ab > 0 ? (tb / t.ab) - (t.h / t.ab) : 0,
    pa: t.pa, hand: vsHand
  };
}

async function getH2H(bid, pid) {
  var results = await Promise.all(HIST.map(function(yr) {
    return fetchJSON(MLB + '/people/' + bid + '/stats?stats=vsPlayer&opposingPlayerId=' + pid + '&season=' + yr + '&group=hitting&gameType=R');
  }));
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

// --- HR Drought detection via recent game logs ---
async function getRecentGameLog(pid) {
  // Fetch current season game log; fall back to last year if no data yet
  var d = await fetchJSON(MLB + '/people/' + pid + '/stats?stats=gameLog&season=' + YR + '&group=hitting&gameType=R');
  var splits = d && d.stats && d.stats[0] && d.stats[0].splits;
  if (!splits || splits.length < 5) {
    // Try last year if current season hasn't started or too few games
    d = await fetchJSON(MLB + '/people/' + pid + '/stats?stats=gameLog&season=' + (YR - 1) + '&group=hitting&gameType=R');
    splits = d && d.stats && d.stats[0] && d.stats[0].splits;
  }
  if (!splits || splits.length === 0) return null;

  // Get last 20 games (most recent first)
  var recent = splits.slice(-20).reverse();
  var gamesSinceHR = 0;
  var foundHR = false;
  var recentAB = 0, recentH = 0, recentHR = 0, recentPA = 0;

  for (var i = 0; i < recent.length; i++) {
    var s = recent[i].stat;
    if (!s) continue;
    recentAB += (s.atBats || 0);
    recentH += (s.hits || 0);
    recentHR += (s.homeRuns || 0);
    recentPA += (s.atBats || 0) + (s.baseOnBalls || 0) + (s.hitByPitch || 0) + (s.sacFlies || 0);
    if (!foundHR) {
      if ((s.homeRuns || 0) > 0) {
        foundHR = true;
      } else {
        gamesSinceHR++;
      }
    }
  }

  // If no HR found in last 20 games, drought = 20+
  if (!foundHR) gamesSinceHR = recent.length;

  return {
    gamesSinceHR: gamesSinceHR,
    recentGames: recent.length,
    recentAB: recentAB,
    recentH: recentH,
    recentHR: recentHR,
    recentPA: recentPA,
    recentAVG: recentAB > 0 ? recentH / recentAB : 0
  };
}

// Determine drought tag: "dingerIncoming", "slump", or null
function calcDroughtTag(gameLog, hrPA, statcast, totHR, numSeasons) {
  if (!gameLog || gameLog.recentGames < 8) return null; // need enough data

  // GATE: Must average at least 8 HR per season AND have 15+ total.
  // 10 HR over 3 years = 3.3/yr = not a power hitter, no drought tag.
  // 24 HR over 2 years = 12/yr = legit power hitter, qualifies.
  numSeasons = Math.max(numSeasons || 1, 1);
  var hrPerSeason = totHR / numSeasons;
  if (!totHR || totHR < 15 || hrPerSeason < 8) return null;

  // Expected games between HRs: 1 / (hrPA * ~4 PA/game)
  var expectedFreq = hrPA > 0 ? 1 / (hrPA * 3.8) : 30;
  var drought = gameLog.gamesSinceHR;

  // Only flag if drought is 2x+ the expected frequency AND at least 5 games
  if (drought < 5 || drought < expectedFreq * 1.8) return null;

  // Check Statcast quality — is he still hitting the ball hard?
  var contactStrong = false;
  if (statcast && statcast.barrelPct > 0) {
    contactStrong = statcast.barrelPct >= LG.barrelPct * 0.85;
  } else if (statcast && statcast.exitVelo > 0) {
    contactStrong = statcast.exitVelo >= 87;
  } else {
    contactStrong = gameLog.recentAVG >= .200;
  }

  var droughtRatio = drought / Math.max(expectedFreq, 1);

  if (contactStrong) {
    return {
      tag: 'dingerIncoming',
      drought: drought,
      expected: +expectedFreq.toFixed(1),
      ratio: +droughtRatio.toFixed(1)
    };
  } else {
    return {
      tag: 'slump',
      drought: drought,
      expected: +expectedFreq.toFixed(1),
      ratio: +droughtRatio.toFixed(1)
    };
  }
}

// --- Weighted stat aggregators ---
function weightPit(seasons) {
  var wE = 0, wW = 0, wHR = 0, wH = 0, wFB = 0, wTot = 0;
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
    // Fly ball rate: flyOuts / (flyOuts + groundOuts) as proxy
    var fo = (s.airOuts || 0), go = (s.groundOuts || 0);
    var fb = (fo + go) > 0 ? (fo / (fo + go)) * 100 : LG.fbPct;
    wFB += fb * fw;
    wTot += fw;
    yrs.push({ yr: yr, ip: s.inningsPitched || '0', era: s.era || '-', whip: s.whip || '-' });
  }
  if (wTot === 0) return null;
  return { era: wE / wTot, whip: wW / wTot, hr9: wHR / wTot, h9: wH / wTot, fbPct: wFB / wTot, yrs: yrs };
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
  var tHR = 0, tAB = 0, tPA = 0;
  for (var y in seasons) {
    tHR += (seasons[y].homeRuns || 0);
    tAB += (seasons[y].atBats || 0);
    tPA += (seasons[y].atBats || 0) + (seasons[y].baseOnBalls || 0) + (seasons[y].hitByPitch || 0) + (seasons[y].sacFlies || 0);
  }

  // Regress HR rate toward league average based on total PA
  // Under 200 PA: heavy regression. 200-500 PA: partial. 500+: trust the data.
  var rawHRPA = wHR / wTot;
  var regWeight = Math.min(tPA / 500, 1); // 0 to 1 scale, full trust at 500 PA
  var regressedHRPA = rawHRPA * regWeight + LG.hrPA * (1 - regWeight);

  // Regress AVG, OBP, SLG toward league averages on small samples
  var regressedAVG = avg * regWeight + LG.avg * (1 - regWeight);
  var regressedOBP = obp * regWeight + LG.obp * (1 - regWeight);
  var regressedSLG = slg * regWeight + LG.slg * (1 - regWeight);

  // Enforce mathematical relationships — these can NEVER be violated
  regressedOBP = Math.max(regressedOBP, regressedAVG);  // OBP >= AVG always
  regressedSLG = Math.max(regressedSLG, regressedAVG);  // SLG >= AVG always

  // Recalculate ISO from regressed values
  var regressedISO = regressedSLG - regressedAVG;

  return { hrPA: regressedHRPA, rawHRPA: rawHRPA, avg: regressedAVG, rawAVG: avg, slg: regressedSLG, obp: regressedOBP, iso: regressedISO, kRate: wSO / wTot, babip: Math.max(.25, Math.min(.36, regressedAVG + .05)), totHR: tHR, totAB: tAB, totPA: tPA, yrs: yrs };
}

// ========== PREDICTION MODELS (v2 calibrated) ==========

function calcHR(b, opp, pf, h2h, platoon, statcast, extras) {
  var base = b.hrPA;
  extras = extras || {};

  // ISO factor — small refinement only, base rate already captures most power signal
  var isoF = b.iso > 0 ? (b.iso / LG.iso) * .10 + .90 : 1;

  // Pitcher factor — HR tendency
  var pitF = 1;
  if (opp) { pitF = Math.max(.55, Math.min(1.45, opp.hr9 > 0 ? opp.hr9 / LG.hr9 : opp.era / LG.era)); }

  // Fly ball rate factor — pitchers who allow more fly balls = more HR chances
  var fbF = 1;
  if (opp && opp.fbPct > 0) {
    fbF = Math.max(.88, Math.min(1.12, opp.fbPct / LG.fbPct));
  }

  // H2H factor — works BOTH directions, sample-size adjusted
  var h2hF = 1;
  if (h2h && h2h.pa >= 6) {
    var sampleW = Math.min(h2h.pa / 40, 1);
    // Minimum floor so even small samples move the needle
    sampleW = Math.max(sampleW, .35);
    if (h2h.hrRate > 0) {
      // Has hit HRs against this pitcher — boost
      var rawH2H = 1 + (h2h.hrRate / LG.hrPA - 1) * .20;
      h2hF = 1 + (Math.max(.85, Math.min(1.25, rawH2H)) - 1) * sampleW;
    } else if (h2h.ab >= 6 && h2h.hr === 0) {
      // Zero HRs — but did he at least get hits?
      if (h2h.h === 0) {
        // 0 hits AND 0 HR = can't touch this pitcher at all. Hard penalty.
        var penaltyRaw = Math.max(.60, .82 - (h2h.ab / 80));
        h2hF = 1 + (penaltyRaw - 1) * sampleW;
      } else {
        // Gets hits but no HR off this pitcher — moderate penalty
        var penaltyRaw = Math.max(.70, .90 - (h2h.ab / 100));
        h2hF = 1 + (penaltyRaw - 1) * sampleW;
      }
    }
  }

  // Platoon factor
  var platF = 1;
  if (platoon && platoon.pa >= 20) {
    var platHRvsOverall = platoon.hrPA / Math.max(b.hrPA, .005);
    platF = Math.max(.75, Math.min(1.35, platHRvsOverall * .3 + .7));
  }

  // Statcast factor — barrel rate
  var scF = 1;
  if (statcast && statcast.barrelPct > 0) {
    var brlRatio = statcast.barrelPct / LG.barrelPct;
    scF = Math.max(.70, Math.min(1.50, brlRatio * .35 + .65));
  }

  // Weather factor (temp + wind)
  var wxF = extras.weather ? extras.weather.combined : 1;

  // Bullpen exposure factor — anytime HR spans 9 innings, not just starter
  // If opposing bullpen has high HR/9, boost probability
  var bpF = 1;
  if (extras.bullpenHR9 > 0) {
    // Starter faces ~60% of PAs, bullpen ~40%
    var bpRatio = extras.bullpenHR9 / LG.bullpenHR9;
    bpF = Math.max(.90, Math.min(1.15, .6 + .4 * bpRatio));
  }

  // Lineup position — protection factor only (PA count handled in geometric conversion)
  var loF = 1;
  if (extras.lineupPos) {
    var lp = extras.lineupPos;
    if (lp <= 4) loF = 1.03;       // 1-4: see slightly better pitches with lineup protection
    else loF = 1.00;               // 5-9: neutral
  }

  // PA per game by lineup position — leadoff gets ~4.5, 9-hole gets ~3.2
  var paPerGame = 3.8;
  if (extras.lineupPos) {
    var lpPA = [4.5, 4.3, 4.2, 4.0, 3.9, 3.8, 3.6, 3.4, 3.2];
    paPerGame = lpPA[Math.min(extras.lineupPos - 1, 8)] || 3.8;
  }

  // Cap the compound multiplier — prevents 10 modest factors from stacking to insane levels
  var compound = isoF * pitF * fbF * (pf || 1) * platF * scF * wxF * bpF * loF;
  compound = Math.max(.55, Math.min(1.40, compound));

  var pp = Math.max(.003, Math.min(.065, base * compound));
  var gm = 1 - Math.pow(1 - pp, paPerGame);

  // Game probability cap: 18% base, up to 22% only for elite power hitters with factors aligned
  var cap = (base >= .05 && compound > 1.20) ? .22 : .18;
  gm = Math.max(.005, Math.min(gm, cap));

  // Apply H2H AFTER cap — bad matchups can always drag the number down
  // but good matchups can't push past the cap
  gm = gm * h2hF;
  gm = Math.max(.005, Math.min(gm, cap)); // re-apply cap as absolute ceiling

  // Career HR floor check — unproven power hitters get hard capped
  // You have to earn a high HR% with actual career production
  if (b.totHR <= 2) {
    gm = Math.min(gm, .04);         // 2 or fewer career HR: max 4%
  } else if (b.totHR <= 5) {
    gm = Math.min(gm, .08);         // 3-5 career HR: max 8%
  } else if (b.totHR <= 10) {
    gm = Math.min(gm, .12);         // 6-10 career HR: max 12%
  } else if (b.totHR <= 15 && b.totPA < 300) {
    gm = Math.min(gm, .15);         // 11-15 HR on small sample: max 15%
  }

  return {
    pct: (gm * 100).toFixed(1),
    f: { base: (base * 100).toFixed(2), iso: isoF.toFixed(2), pitcher: pitF.toFixed(2), flyball: fbF.toFixed(2), park: (pf || 1).toFixed(2), h2h: h2hF.toFixed(2), platoon: platF.toFixed(2), statcast: scF.toFixed(2), weather: wxF.toFixed(2), bullpen: bpF.toFixed(2), lineup: loF.toFixed(2) }
  };
}

function calcHit(b, opp, pf, h2h, platoon, statcast, extras) {
  var base = b.avg;
  extras = extras || {};
  var cF = b.babip > 0 ? (b.babip / LG.babip) * .25 + .75 : 1;

  var pitF = 1;
  if (opp) { pitF = opp.h9 > 0 ? opp.h9 / LG.h9 : opp.whip > 0 ? opp.whip / LG.whip : 1; }

  var dF = 1;
  if (b.obp > 0) { dF = Math.max(.80, Math.min(1.25, (1 + (b.obp - .320) * .5) * (1 + (.22 - b.kRate) * .3))); }

  var h2hF = 1;
  if (h2h && h2h.pa >= 6) {
    var sampleW = Math.min(h2h.pa / 40, 1);
    sampleW = Math.max(sampleW, .35);
    if (h2h.ab >= 5 && h2h.avg > 0) {
      // Has hits — boost or penalize based on avg vs league
      var rawH2H = 1 + (h2h.avg / LG.avg - 1) * .20;
      h2hF = 1 + (Math.max(.80, Math.min(1.25, rawH2H)) - 1) * sampleW;
    } else if (h2h.ab >= 6 && h2h.h === 0) {
      // Zero hits — this pitcher completely owns him
      var penaltyRaw = Math.max(.55, .78 - (h2h.ab / 60));
      h2hF = 1 + (penaltyRaw - 1) * sampleW;
    } else if (h2h.ab >= 5 && h2h.avg < LG.avg) {
      // Below league average — mild penalty
      var rawH2H = 1 + (h2h.avg / LG.avg - 1) * .20;
      h2hF = 1 + (Math.max(.80, Math.min(1.0, rawH2H)) - 1) * sampleW;
    }
  }

  var platF = 1;
  if (platoon && platoon.pa >= 20) {
    var platAvgRatio = platoon.avg / Math.max(b.avg, .100);
    platF = Math.max(.80, Math.min(1.30, platAvgRatio * .35 + .65));
  }

  var scF = 1;
  if (statcast && statcast.xBA > 0 && b.avg > 0) {
    var xbaRatio = statcast.xBA / Math.max(b.avg, .150);
    scF = Math.max(.85, Math.min(1.20, xbaRatio * .25 + .75));
  }

  // Lineup position — protection only (PA handled in geometric conversion)
  var loF = 1;
  if (extras.lineupPos) {
    if (extras.lineupPos <= 4) loF = 1.02;  // Slight boost for lineup protection
  }

  // PA per game by lineup position
  var paPerGame = 3.8;
  if (extras.lineupPos) {
    var lpPA = [4.5, 4.3, 4.2, 4.0, 3.9, 3.8, 3.6, 3.4, 3.2];
    paPerGame = lpPA[Math.min(extras.lineupPos - 1, 8)] || 3.8;
  }

  var pp = Math.max(.10, Math.min(.42, base * cF * pitF * (pf || 1) * dF * platF * scF * loF));
  var gm = 1 - Math.pow(1 - pp, paPerGame);

  // Apply H2H after geometric conversion so bad matchups visibly drag the number
  gm = Math.max(.05, Math.min(.98, gm * h2hF));

  return {
    pct: (gm * 100).toFixed(1),
    f: { base: (base * 1000).toFixed(0), contact: cF.toFixed(2), pitcher: pitF.toFixed(2), park: (pf || 1).toFixed(2), disc: dF.toFixed(2), h2h: h2hF.toFixed(2), platoon: platF.toFixed(2), statcast: scF.toFixed(2), lineup: loF.toFixed(2) }
  };
}

// --- Game winner prediction (v2 with Pythagorean) ---
function calcWin(a, h, aP, hP, venue) {
  var rpf = gpf(venue, 'run');

  // Pythagorean expected win%
  var aPyth = a.gp >= 20 ? pythagWin(a.rs * a.gp, a.ra * a.gp) : a.gp >= 5 ? pythagWin(a.rs * a.gp, a.ra * a.gp) * (a.gp / 20) + .5 * (1 - a.gp / 20) : .5;
  var hPyth = h.gp >= 20 ? pythagWin(h.rs * h.gp, h.ra * h.gp) : h.gp >= 5 ? pythagWin(h.rs * h.gp, h.ra * h.gp) * (h.gp / 20) + .5 * (1 - h.gp / 20) : .5;

  // Blend Pythagorean with raw win% early season
  var aW = a.gp >= 40 ? aPyth : aPyth * .6 + a.wp * .4;
  var hW = h.gp >= 40 ? hPyth : hPyth * .6 + h.wp * .4;

  var aE = aP ? aP.era : LG.era, hE = hP ? hP.era : LG.era;
  var aSF = LG.era / Math.max(aE, 1.5), hSF = LG.era / Math.max(hE, 1.5);

  // v2 calibrated logistic model
  var tot = (aW - hW) * .90           // Pythagorean team strength
          + (aSF - hSF) * .30         // Starter quality
          + (a.ops - h.ops) * .25     // Team offense
          + ((a.l10 || .5) - (h.l10 || .5)) * .40  // Recent form
          + (a.rdPG - h.rdPG) * .03   // Run differential momentum
          - .035;                      // Home advantage (~53.5%)

  var awP = 1 / (1 + Math.exp(-tot * 4.2));

  var bR = LG.rpg * rpf;
  // Dampened pitcher effect on run totals
  // Old formula divided by SF which exploded on extreme ERAs (6.50 ERA → 1.55x runs)
  // New formula: linear scaling dampened at 50% — reasonable range ±25-30%
  var aPitEffect = 1 + (hE - LG.era) / LG.era * .50;  // How opposing (home) pitcher affects away runs
  var hPitEffect = 1 + (aE - LG.era) / LG.era * .50;  // How opposing (away) pitcher affects home runs
  aPitEffect = Math.max(.70, Math.min(1.35, aPitEffect));  // Hard clamp
  hPitEffect = Math.max(.70, Math.min(1.35, hPitEffect));
  return {
    aProb: Math.round(awP * 100), hProb: Math.round((1 - awP) * 100),
    aRuns: Math.max(1, Math.round(bR * (a.ops / .72) * aPitEffect * 10) / 10),
    hRuns: Math.max(1, Math.round(bR * (h.ops / .72) * hPitEffect * 10) / 10),
    det: {
      aERA: aE.toFixed(2), hERA: hE.toFixed(2),
      aPyth: (aPyth * 100).toFixed(1), hPyth: (hPyth * 100).toFixed(1),
      aRS: a.rs ? a.rs.toFixed(2) : '-', aRA: a.ra ? a.ra.toFixed(2) : '-',
      hRS: h.rs ? h.rs.toFixed(2) : '-', hRA: h.ra ? h.ra.toFixed(2) : '-'
    }
  };
}

// ===================== MAIN HANDLER =====================
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');

  var date = req.query.date || new Date().toISOString().slice(0, 10);

  try {
    // Step 1: Schedule + Standings + Statcast (parallel)
    var [schedData, standData, standDataPrev, statcastData] = await Promise.all([
      fetchJSON(MLB + '/schedule?sportId=1&date=' + date + '&hydrate=probablePitcher(note),team,linescore,venue,weather'),
      fetchJSON(MLB + '/standings?leagueId=103,104&season=' + YR + '&standingsTypes=regularSeason&hydrate=team'),
      fetchJSON(MLB + '/standings?leagueId=103,104&season=' + (YR - 1) + '&standingsTypes=regularSeason&hydrate=team'),
      fetchStatcast()
    ]);

    var games = (schedData && schedData.dates && schedData.dates[0] && schedData.dates[0].games) || [];
    if (games.length === 0) {
      return res.status(200).json({ date: date, games: [], batters: [], gamePreds: [], noGames: true, modelVersion: 'v3' });
    }

    // Parse standings with RS/RA for Pythagorean
    var standings = {};
    [standData, standDataPrev].forEach(function(sd) {
      if (!sd || !sd.records) return;
      sd.records.forEach(function(rec) {
        (rec.teamRecords || []).forEach(function(tr) {
          var tid = tr.team && tr.team.id;
          if (!tid || (standings[tid] && standings[tid].yr === YR)) return;
          var l10 = (tr.records && tr.records.splitRecords || []).find(function(s) { return s.type === 'lastTen'; });
          var gp = (tr.wins || 0) + (tr.losses || 0);
          var rd = tr.runDifferential || 0;

          // Try direct RS/RA, else estimate from RD
          var rs, ra;
          if (tr.runsScored != null && tr.runsAllowed != null && gp > 0) {
            rs = tr.runsScored / gp;
            ra = tr.runsAllowed / gp;
          } else {
            var est = computeRSRA(rd, gp);
            rs = est.rs; ra = est.ra;
          }

          standings[tid] = {
            wins: tr.wins || 0, losses: tr.losses || 0, pct: parseFloat(tr.winningPercentage) || .5,
            rd: rd, gp: gp, rs: rs, ra: ra,
            pythWin: gp >= 10 ? pythagWin(rs * gp, ra * gp) : .5,
            l10w: l10 && l10.wins, l10l: l10 && l10.losses,
            streak: tr.streak && tr.streak.streakCode || '', yr: sd === standData ? YR : YR - 1
          };
        });
      });
    });

    // Step 2: Team batting + pitching stats (for bullpen HR/9)
    var teamIds = new Set();
    games.forEach(function(g) { teamIds.add(g.teams.away.team.id); teamIds.add(g.teams.home.team.id); });
    var teamBatPromises = [];
    var teamPitPromises = [];
    teamIds.forEach(function(tid) {
      teamBatPromises.push(
        fetchJSON(MLB + '/teams/' + tid + '/stats?stats=season&season=' + YR + '&group=hitting&gameType=R')
          .then(function(d) { return { tid: tid, yr: YR, stat: d && d.stats && d.stats[0] && d.stats[0].splits && d.stats[0].splits[0] && d.stats[0].splits[0].stat }; })
      );
      teamBatPromises.push(
        fetchJSON(MLB + '/teams/' + tid + '/stats?stats=season&season=' + (YR - 1) + '&group=hitting&gameType=R')
          .then(function(d) { return { tid: tid, yr: YR - 1, stat: d && d.stats && d.stats[0] && d.stats[0].splits && d.stats[0].splits[0] && d.stats[0].splits[0].stat }; })
      );
      // Team pitching stats for bullpen HR/9 estimate
      teamPitPromises.push(
        fetchJSON(MLB + '/teams/' + tid + '/stats?stats=season&season=' + YR + '&group=pitching&gameType=R')
          .then(function(d) { return { tid: tid, yr: YR, stat: d && d.stats && d.stats[0] && d.stats[0].splits && d.stats[0].splits[0] && d.stats[0].splits[0].stat }; })
      );
      teamPitPromises.push(
        fetchJSON(MLB + '/teams/' + tid + '/stats?stats=season&season=' + (YR - 1) + '&group=pitching&gameType=R')
          .then(function(d) { return { tid: tid, yr: YR - 1, stat: d && d.stats && d.stats[0] && d.stats[0].splits && d.stats[0].splits[0] && d.stats[0].splits[0].stat }; })
      );
    });
    var [teamBatResults, teamPitResults] = await Promise.all([
      Promise.all(teamBatPromises),
      Promise.all(teamPitPromises)
    ]);
    var teamBat = {};
    teamBatResults.forEach(function(r) {
      if (r.stat && (r.stat.atBats || 0) > 100 && (!teamBat[r.tid] || r.yr === YR)) {
        teamBat[r.tid] = { ops: parseFloat(r.stat.ops) || .720 };
      }
    });
    // Extract team pitching HR/9 as a proxy for bullpen HR/9
    // (team HR/9 minus starter tends toward bullpen, but team-level is a reasonable proxy)
    var teamBullpen = {};
    teamPitResults.forEach(function(r) {
      if (r.stat && (!teamBullpen[r.tid] || r.yr === YR)) {
        var ip = parseFloat(r.stat.inningsPitched) || 0;
        if (ip > 50) {
          teamBullpen[r.tid] = { hr9: parseFloat(r.stat.homeRunsPer9) || LG.bullpenHR9 };
        }
      }
    });

    // Step 3: Pitcher stats + handedness (parallel)
    var pitcherIds = new Set();
    games.forEach(function(g) {
      if (g.teams.away.probablePitcher) pitcherIds.add(g.teams.away.probablePitcher.id);
      if (g.teams.home.probablePitcher) pitcherIds.add(g.teams.home.probablePitcher.id);
    });

    var pitcherPromises = [];
    var handPromises = [];
    pitcherIds.forEach(function(pid) {
      pitcherPromises.push(getMultiPitching(pid).then(function(s) { return { pid: pid, seasons: s }; }));
      handPromises.push(fetchPitcherHand(pid).then(function(h) { return { pid: pid, hand: h }; }));
    });

    var boxPromises = games.map(function(g) {
      return fetchJSON(MLB + '/game/' + g.gamePk + '/boxscore').then(function(b) { return { pk: g.gamePk, box: b }; });
    });

    var [pitcherResults, handResults, boxResults] = await Promise.all([
      Promise.all(pitcherPromises),
      Promise.all(handPromises),
      Promise.all(boxPromises)
    ]);

    var pitcherStats = {};
    pitcherResults.forEach(function(r) { pitcherStats[r.pid] = weightPit(r.seasons); });

    var pitcherHands = {};
    handResults.forEach(function(r) { pitcherHands[r.pid] = r.hand; });

    var boxscores = {};
    boxResults.forEach(function(r) { boxscores[r.pk] = r.box; });

    // Step 4: Process games — predictions + batter collection
    var gamePreds = [];
    var allBatterJobs = [];

    games.forEach(function(g) {
      var aw = g.teams.away.team, ho = g.teams.home.team;
      var venue = g.venue && g.venue.name || '';
      var apId = g.teams.away.probablePitcher && g.teams.away.probablePitcher.id;
      var hpId = g.teams.home.probablePitcher && g.teams.home.probablePitcher.id;
      var apW = pitcherStats[apId] || null;
      var hpW = pitcherStats[hpId] || null;
      var aSt = standings[aw.id] || { wins: 81, losses: 81, pct: .5, rd: 0, gp: 162, rs: LG.rpg, ra: LG.rpg };
      var hSt = standings[ho.id] || { wins: 81, losses: 81, pct: .5, rd: 0, gp: 162, rs: LG.rpg, ra: LG.rpg };

      // Parse weather from MLB API hydration
      var rawWeather = g.weather || null;
      var weather = calcWeatherFactor(rawWeather);

      // Bullpen HR/9 for each team (opponent's bullpen matters to the batting team)
      var awayBullpenHR9 = (teamBullpen[aw.id] || {}).hr9 || LG.bullpenHR9;
      var homeBullpenHR9 = (teamBullpen[ho.id] || {}).hr9 || LG.bullpenHR9;

      var pred = calcWin(
        { abbr: aw.abbreviation, wp: aSt.pct, ops: (teamBat[aw.id] || { ops: .72 }).ops, l10: aSt.l10w ? aSt.l10w / 10 : .5, rdPG: aSt.gp > 0 ? aSt.rd / aSt.gp : 0, gp: aSt.gp, rs: aSt.rs || LG.rpg, ra: aSt.ra || LG.rpg },
        { abbr: ho.abbreviation, wp: hSt.pct, ops: (teamBat[ho.id] || { ops: .72 }).ops, l10: hSt.l10w ? hSt.l10w / 10 : .5, rdPG: hSt.gp > 0 ? hSt.rd / hSt.gp : 0, gp: hSt.gp, rs: hSt.rs || LG.rpg, ra: hSt.ra || LG.rpg },
        apW, hpW, venue
      );

      var gObj = {
        gamePk: g.gamePk, away: aw.abbreviation, home: ho.abbreviation,
        awayName: aw.name, homeName: ho.name, venue: venue,
        gameDate: g.gameDate, status: g.status && g.status.abstractGameState,
        awaySP: g.teams.away.probablePitcher && g.teams.away.probablePitcher.fullName || 'TBD',
        homeSP: g.teams.home.probablePitcher && g.teams.home.probablePitcher.fullName || 'TBD',
        awaySPHand: pitcherHands[apId] || '?',
        homeSPHand: pitcherHands[hpId] || '?',
        awaySPFB: apW ? apW.fbPct.toFixed(1) : null,
        homeSPFB: hpW ? hpW.fbPct.toFixed(1) : null,
        aRec: aSt.wins + '-' + aSt.losses, hRec: hSt.wins + '-' + hSt.losses,
        aPitYrs: apW ? apW.yrs : [], hPitYrs: hpW ? hpW.yrs : [],
        weather: rawWeather ? { temp: rawWeather.temp || null, wind: rawWeather.wind || null, condition: rawWeather.condition || null, factor: weather } : null,
        pred: pred
      };
      gamePreds.push(gObj);

      // Collect batters from boxscore with lineup position
      var box = boxscores[g.gamePk];
      if (box && box.teams) {
        ['away', 'home'].forEach(function(side) {
          var td = box.teams[side];
          if (!td) return;
          var order = (td.battingOrder || []).slice(0, 9);
          var players = td.players || {};
          order.forEach(function(pid, orderIdx) {
            var p = players['ID' + pid];
            if (!p) return;
            var oppPitcherId = side === 'away' ? hpId : apId;
            // Opposing bullpen HR/9 (the bullpen the batter will face later in the game)
            var oppBullpenHR9 = side === 'away' ? homeBullpenHR9 : awayBullpenHR9;
            allBatterJobs.push({
              pid: pid, side: side, gamePk: g.gamePk,
              name: p.person && p.person.fullName || 'Unknown',
              pos: p.position && p.position.abbreviation || '',
              team: side === 'away' ? aw.abbreviation : ho.abbreviation,
              oppPW: side === 'away' ? hpW : apW,
              oppPId: oppPitcherId,
              oppPName: side === 'away' ? gObj.homeSP : gObj.awaySP,
              oppPHand: pitcherHands[oppPitcherId] || 'R',
              venue: venue,
              lineupPos: orderIdx + 1,
              weather: weather,
              bullpenHR9: oppBullpenHR9,
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

    // Step 5: Fetch batter stats + platoon splits (batched)
    var BATCH = 8;
    var allBatters = [];
    var statcastCount = 0;

    for (var i = 0; i < allBatterJobs.length; i += BATCH) {
      var batch = allBatterJobs.slice(i, i + BATCH);
      var batchResults = await Promise.all(batch.map(function(job) {
        return Promise.all([
          getMultiHitting(job.pid),
          job.oppPId ? getH2H(job.pid, job.oppPId) : Promise.resolve(null),
          getPlatoonSplits(job.pid, job.oppPHand),
          getRecentGameLog(job.pid)
        ]).then(function(results) {
          return { job: job, seasons: results[0], h2h: results[1], platoon: results[2], gameLog: results[3] };
        });
      }));

      batchResults.forEach(function(r) {
        var bW = weightBat(r.seasons);
        if (!bW) return;
        var job = r.job;
        var pfHR = gpf(job.venue, 'hr');
        var pfHit = gpf(job.venue, 'hit');
        var sc = statcastData[job.pid] || null;
        if (sc) statcastCount++;

        // Drought tag calculation
        var droughtTag = calcDroughtTag(r.gameLog, bW.hrPA, sc, bW.totHR, bW.yrs ? bW.yrs.length : 1);

        var extras = { weather: job.weather, bullpenHR9: job.bullpenHR9, lineupPos: job.lineupPos };
        var hrR = calcHR(bW, job.oppPW, pfHR, r.h2h, r.platoon, sc, extras);
        var hitR = calcHit(bW, job.oppPW, pfHit, r.h2h, r.platoon, sc, extras);

        allBatters.push({
          id: job.pid, name: job.name, team: job.team, side: job.side,
          pos: job.pos, gamePk: job.gamePk,
          avg: bW.avg, slg: bW.slg, obp: bW.obp, iso: bW.iso,
          totHR: bW.totHR, totAB: bW.totAB, yrs: bW.yrs,
          hrPct: hrR.pct, hrF: hrR.f,
          hitPct: hitR.pct, hitF: hitR.f,
          h2h: r.h2h, oppP: job.oppPName,
          oppPHand: job.oppPHand,
          lineupPos: job.lineupPos,
          platoon: r.platoon ? { avg: r.platoon.avg.toFixed(3), hrPA: (r.platoon.hrPA * 100).toFixed(2), pa: r.platoon.pa, hand: r.platoon.hand } : null,
          statcast: sc ? { barrelPct: sc.barrelPct, exitVelo: sc.exitVelo, xBA: sc.xBA, xSLG: sc.xSLG } : null,
          droughtTag: droughtTag,
          gs: job.gameStats
        });
      });
    }

    return res.status(200).json({
      date: date,
      modelVersion: 'v3',
      modelInfo: {
        pythagorean: true,
        platoonSplits: true,
        statcast: statcastCount > 0,
        statcastCount: statcastCount,
        weather: true,
        flyBallRate: true,
        bullpenHR9: true,
        lineupPosition: true,
        calibrated: true
      },
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
