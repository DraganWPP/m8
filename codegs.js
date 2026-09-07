/* ============================================================
 Audit M8 — GTM + GA4 Validator  |  Code.gs
 ============================================================ */

var GTM_BASE  = 'https://tagmanager.googleapis.com/tagmanager/v2';
var ADM_BASE  = 'https://analyticsadmin.googleapis.com/v1beta';
var DATA_BASE = 'https://analyticsdata.googleapis.com/v1beta';
var GROQ_URL  = 'https://api.groq.com/openai/v1/chat/completions';
var CM360_BASE = 'https://dfareporting.googleapis.com/dfareporting/v5';

/* ============================================================
 SERVE WEB APP
 ============================================================ */
function doGet(e) {
  if (e.parameter.cm360auth === '1') {
    var service = getCm360Service();
    if (service.hasAccess()) {
      return HtmlService.createHtmlOutput('Already authorized!');
    }
    var url = service.getAuthorizationUrl();
    return HtmlService.createHtmlOutput('<a href="' + url + '" target="_blank">Click here to authorize CM360</a>');
  }
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Audit M8')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* ============================================================
 REAL-TIME PROGRESS (CacheService polling)
 ============================================================ */
function setProgress_(sid, step, message) {
  try {
    var cache = CacheService.getScriptCache();
    var key   = 'prog_' + sid;
    var raw   = cache.get(key);
    var data  = raw ? JSON.parse(raw) : { steps: [], done: false, error: null };
    data.steps.push({ t: new Date().toLocaleTimeString('en-GB'), s: step, m: message });
    cache.put(key, JSON.stringify(data), 600);
    Logger.log('[Step ' + step + '] ' + message);
  } catch(e) { Logger.log('[setProgress_] ' + e.message); }
}

function setDone_(sid, result) {
  try {
    var cache = CacheService.getScriptCache();
    var key   = 'prog_' + sid;
    var raw   = cache.get(key);
    var data  = raw ? JSON.parse(raw) : { steps: [], done: false, error: null };
    data.done = true; data.result = result;
    cache.put(key, JSON.stringify(data), 600);
  } catch(e) { Logger.log('[setDone_] ' + e.message); }
}

function setError_(sid, message) {
  try {
    var cache = CacheService.getScriptCache();
    var key   = 'prog_' + sid;
    var raw   = cache.get(key);
    var data  = raw ? JSON.parse(raw) : { steps: [], done: false, error: null };
    data.done = true; data.error = message;
    cache.put(key, JSON.stringify(data), 600);
  } catch(e) { Logger.log('[setError_] ' + e.message); }
}

function getProgress(sid) {
  try {
    var raw = CacheService.getScriptCache().get('prog_' + sid);
    return raw ? JSON.parse(raw) : { steps: [], done: false, error: null };
  } catch(e) { return { steps: [], done: false, error: e.message }; }
}

/* ============================================================
 GROQ — models + test
 ============================================================ */
function getGroqModels() {
  return {
    ok: true,
    data: [
      { id: 'llama-3.1-8b-instant',    name: 'Llama 3.1 8B  — 20k TPM (recommended)' },
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B — 12k TPM' },
      { id: 'llama-3.1-70b-versatile', name: 'Llama 3.1 70B — 12k TPM' },
      { id: 'gemma2-9b-it',            name: 'Gemma 2 9B    — 15k TPM' },
      { id: 'mixtral-8x7b-32768',      name: 'Mixtral 8x7B  — 5k TPM'  }
    ]
  };
}

function testGroqConnection(apiKey, model) {
  try {
    var result = callGroq_(
      apiKey,
      model || 'llama-3.1-8b-instant',
      'Return exactly this JSON and nothing else: {"status":"ok","message":"Groq connected"}'
    );
    return { ok: true, response: result };
  } catch(e) { return { ok: false, error: e.message }; }
}

/* ============================================================
 GENERIC GOOGLE API FETCH (with retry) — for GTM/GA4 (company account)
 ============================================================ */
function gFetch(url, options, retries) {
  retries = retries || 3;
  var token = ScriptApp.getOAuthToken();
  var opts  = { muteHttpExceptions: true, headers: { 'Authorization': 'Bearer ' + token } };
  if (options) {
    if (options.method)  opts.method  = options.method;
    if (options.payload) { opts.payload = options.payload; opts.headers['Content-Type'] = 'application/json'; }
  }
  for (var attempt = 1; attempt <= retries; attempt++) {
    try {
      var res  = UrlFetchApp.fetch(url, opts);
      var code = res.getResponseCode();
      var text = res.getContentText();
      if ((code === 503 || code === 500 || code === 429) && attempt < retries) {
        Logger.log('[gFetch] ' + code + ' attempt ' + attempt + ' retrying...');
        Utilities.sleep(attempt * 2000);
        continue;
      }
      if (code < 200 || code >= 300) {
        var msg = 'HTTP ' + code;
        try { msg = JSON.parse(text).error.message || msg; } catch(e) {}
        throw new Error(msg);
      }
      try { return JSON.parse(text); } catch(e) { return {}; }
    } catch(e) {
      if (attempt === retries) throw e;
      Logger.log('[gFetch] attempt ' + attempt + ' failed: ' + e.message);
      Utilities.sleep(attempt * 2000);
    }
  }
}

/* ============================================================
 CM360 — OAuth2 Service (separate identity from company account)
 ============================================================ */
function getCm360Service() {
  var props = PropertiesService.getScriptProperties();
  return OAuth2.createService('cm360')
    .setAuthorizationBaseUrl('https://accounts.google.com/o/oauth2/auth')
    .setTokenUrl('https://oauth2.googleapis.com/token')
    .setClientId(props.getProperty('CM360_CLIENT_ID'))
    .setClientSecret(props.getProperty('CM360_CLIENT_SECRET'))
    .setCallbackFunction('authCallback')
    .setPropertyStore(props)
    .setScope('https://www.googleapis.com/auth/dfareporting https://www.googleapis.com/auth/dfatrafficking')
    .setParam('access_type', 'offline')
    .setParam('prompt', 'consent');
}

function authorizeCm360() {
  var service = getCm360Service();
  if (service.hasAccess()) {
    Logger.log('Already authorized. Access token: ' + service.getAccessToken());
  } else {
    var authorizationUrl = service.getAuthorizationUrl();
    Logger.log('Open this URL and authorize as the CM360 account:\n' + authorizationUrl);
  }
}

function authCallback(request) {
  var service = getCm360Service();
  var isAuthorized = service.handleCallback(request);
  if (isAuthorized) {
    return HtmlService.createHtmlOutput('Success! CM360 authorized. You can close this tab.');
  } else {
    return HtmlService.createHtmlOutput('Denied. Access not granted.');
  }
}

function resetCm360Auth() {
  getCm360Service().reset();
  Logger.log('CM360 auth reset.');
}

function getCm360AuthUrl() {
  var service = getCm360Service();
  if (service.hasAccess()) return 'Already authorized!';
  return service.getAuthorizationUrl();
}

/* ============================================================
 CM360 — Generic fetch helper
 ============================================================ */
function cm360Fetch_(url, options) {
  var service = getCm360Service();
  if (!service.hasAccess()) {
    throw new Error('CM360 not authorized. Run authorizeCm360() once to set it up.');
  }
  var opts = {
    headers: { Authorization: 'Bearer ' + service.getAccessToken() },
    muteHttpExceptions: true
  };
  if (options) {
    if (options.method)  opts.method  = options.method;
    if (options.payload) { opts.payload = options.payload; opts.headers['Content-Type'] = 'application/json'; }
  }
  var res = UrlFetchApp.fetch(url, opts);
  var code = res.getResponseCode(), text = res.getContentText();
  if (code < 200 || code >= 300) {
    var msg = 'CM360 API error ' + code;
    try { msg = JSON.parse(text).error.message || msg; } catch(e) {}
    throw new Error(msg);
  }
  try { return JSON.parse(text); } catch(e) { return {}; }
}

/* ============================================================
 CM360 — Profiles / Advertisers / Floodlight Activities
 ============================================================ */
function getCm360Profiles() {
  try {
    var r = cm360Fetch_(CM360_BASE + '/userprofiles');
    return { ok: true, data: (r.items || []).map(function(p) {
      return { profileId: p.profileId, accountName: p.accountName, userName: p.userName };
    }) };
  } catch(e) { return { ok: false, error: e.message }; }
}
function getCm360Advertisers(profileId) {
  try {
    var url = CM360_BASE + '/userprofiles/' + profileId + '/advertisers?maxResults=200';
    var allAdvertisers = [];
    var nextPageToken = null;
    do {
      var pageUrl = url + (nextPageToken ? '&pageToken=' + nextPageToken : '');
      var r = cm360Fetch_(pageUrl);
      allAdvertisers = allAdvertisers.concat(r.advertisers || []);
      nextPageToken = r.nextPageToken || null;
    } while (nextPageToken);

    return { ok: true, data: allAdvertisers.map(function(a) {
      return { id: a.id, name: a.name, floodlightConfigurationId: a.floodlightConfigurationId, status: a.status };
    }) };
  } catch(e) { return { ok: false, error: e.message }; }
}

function getFloodlightActivities(profileId, advertiserId) {
  try {
    var url = CM360_BASE + '/userprofiles/' + profileId + '/floodlightActivities';
    if (advertiserId) url += '?advertiserId=' + advertiserId;
    var allActivities = [];
    var nextPageToken = null;
    do {
      var pageUrl = url + (nextPageToken ? (url.indexOf('?') > -1 ? '&' : '?') + 'pageToken=' + nextPageToken : '');
      var r = cm360Fetch_(pageUrl);
      allActivities = allActivities.concat(r.floodlightActivities || []);
      nextPageToken = r.nextPageToken || null;
    } while (nextPageToken && allActivities.length < 2000);

    return { ok: true, data: allActivities.map(function(a) {
      return {
        id: a.id, name: a.name, tagString: a.tagString,
        floodlightTagType: a.floodlightTagType, status: a.status || 'ACTIVE',
        countingMethod: a.countingMethod, expectedUrl: a.expectedUrl,
        groupName: a.floodlightActivityGroupName, groupType: a.floodlightActivityGroupType,
        groupTagString: a.floodlightActivityGroupTagString
      };
    }) };
  } catch(e) { return { ok: false, error: e.message }; }
}

function getFloodlightConfigs(profileId) {
  try {
    var r = cm360Fetch_(CM360_BASE + '/userprofiles/' + profileId + '/floodlightConfigurations');
    return { ok: true, data: (r.floodlightConfigurations || []).map(function(c) {
      return { id: c.id, advertiserId: c.advertiserId };
    }) };
  } catch(e) { return { ok: false, error: e.message }; }
}

/* ============================================================
 CM360 — Floodlight Reports (hit counts via Reports API)
 ============================================================ */
function createFloodlightReport_(profileId, advertiserId, floodlightConfigId) {
  var reportDef = {
    name: 'AuditM8_Floodlight_' + advertiserId + '_' + new Date().getTime(),
    type: 'FLOODLIGHT',
    floodlightCriteria: {
      dateRange: { relativeDateRange: 'LAST_30_DAYS' },
      dimensions: [{ name: 'activity' }, { name: 'activityId' }],
      metricNames: ['activityClickThroughConversions', 'activityViewThroughConversions'],
      floodlightConfigId: {
        dimensionName: 'floodlightConfigId',
        value: floodlightConfigId,
        matchType: 'EXACT'
      }
    },
    format: 'CSV'
  };
  var url = CM360_BASE + '/userprofiles/' + profileId + '/reports';
  return cm360Fetch_(url, { method: 'post', payload: JSON.stringify(reportDef) });
}

function runFloodlightReport_(profileId, reportId) {
  var url = CM360_BASE + '/userprofiles/' + profileId + '/reports/' + reportId + '/run';
  return cm360Fetch_(url, { method: 'post' });
}

function pollFloodlightReportFile_(profileId, reportId, fileId, maxWaitMs) {
  var url = CM360_BASE + '/userprofiles/' + profileId + '/reports/' + reportId + '/files/' + fileId;
  var start = new Date().getTime();
  maxWaitMs = maxWaitMs || 180000; // 3 minutes

  while (new Date().getTime() - start < maxWaitMs) {
    var file = cm360Fetch_(url);
    Logger.log('[Floodlight Report] Status: ' + file.status + ' (elapsed: ' + Math.round((new Date().getTime() - start)/1000) + 's)');
    if (file.status === 'REPORT_AVAILABLE') return file;
    if (file.status === 'FAILED' || file.status === 'CANCELLED') throw new Error('Report generation failed: ' + file.status);
    Utilities.sleep(5000); // check every 5s instead of 3s to reduce API calls
  }
  throw new Error('Report timed out after ' + (maxWaitMs / 1000) + 's — CM360 report may still be processing. Try again in a minute.');
}

function downloadFloodlightReportCsv_(profileId, reportId, fileId) {
  var service = getCm360Service();
  var url = CM360_BASE + '/userprofiles/' + profileId + '/reports/' + reportId + '/files/' + fileId + '?alt=media';
  var res = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + service.getAccessToken() },
    muteHttpExceptions: true
  });
  return res.getContentText();
}

function parseFloodlightCsv_(csv) {
  var lines = csv.split('\n');
  var headerIdx = -1, headers = [];
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('Activity') > -1 && lines[i].indexOf(',') > -1) {
      headers = lines[i].split(',').map(function(h) { return h.replace(/"/g, '').trim(); });
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return [];

  var rows = [];
  for (var j = headerIdx + 1; j < lines.length; j++) {
    var line = lines[j].trim();
    if (!line || line.indexOf('Grand Total') > -1) break;
    var cols = line.split(',').map(function(c) { return c.replace(/"/g, '').trim(); });
    if (cols.length < headers.length) continue;
    var row = {};
    headers.forEach(function(h, idx) { row[h] = cols[idx]; });
    rows.push(row);
  }
  return rows;
}

/**
 * Main entry point for hit counts — orchestrates create → run → poll → download → parse.
 * Takes 15-45 seconds typically.
 */
function getFloodlightHitCounts(profileId, advertiserId, floodlightConfigId) {
  try {
    var created = createFloodlightReport_(profileId, advertiserId, floodlightConfigId);
    var reportId = created.id;
    var ran = runFloodlightReport_(profileId, reportId);
    var fileId = ran.id;
    var file = pollFloodlightReportFile_(profileId, reportId, fileId, 180000); // 3 min
    var csv = downloadFloodlightReportCsv_(profileId, reportId, fileId);
    var rows = parseFloodlightCsv_(csv);

    try {
      var delUrl = CM360_BASE + '/userprofiles/' + profileId + '/reports/' + reportId;
      var service = getCm360Service();
      UrlFetchApp.fetch(delUrl, { method: 'delete', headers: { Authorization: 'Bearer ' + service.getAccessToken() }, muteHttpExceptions: true });
    } catch(e) {}

    return { ok: true, data: rows };
  } catch(e) { return { ok: false, error: e.message }; }
}

/* ============================================================
 CM360 — Floodlight Reports: NON-BLOCKING (for frontend polling)
 ============================================================ */
function startFloodlightReport(profileId, advertiserId, floodlightConfigId) {
  try {
    var created = createFloodlightReport_(profileId, advertiserId, floodlightConfigId);
    var reportId = created.id;
    var ran = runFloodlightReport_(profileId, reportId);
    var fileId = ran.id;
    return { ok: true, reportId: reportId, fileId: fileId };
  } catch(e) { return { ok: false, error: e.message }; }
}

function checkFloodlightReportStatus(profileId, reportId, fileId) {
  try {
    var url = CM360_BASE + '/userprofiles/' + profileId + '/reports/' + reportId + '/files/' + fileId;
    var file = cm360Fetch_(url);
    if (file.status === 'REPORT_AVAILABLE') {
      var csv = downloadFloodlightReportCsv_(profileId, reportId, fileId);
      var rows = parseFloodlightCsv_(csv);
      try {
        var delUrl = CM360_BASE + '/userprofiles/' + profileId + '/reports/' + reportId;
        var service = getCm360Service();
        UrlFetchApp.fetch(delUrl, { method: 'delete', headers: { Authorization: 'Bearer ' + service.getAccessToken() }, muteHttpExceptions: true });
      } catch(e) {}
      return { ok: true, done: true, data: rows };
    }
    if (file.status === 'FAILED' || file.status === 'CANCELLED') {
      return { ok: false, done: true, error: 'Report generation failed: ' + file.status };
    }
    return { ok: true, done: false, status: file.status };
  } catch(e) { return { ok: false, done: true, error: e.message }; }
}

/* ============================================================
 CM360 — GTM Floodlight tag matching
 ============================================================ */
function parseFloodlightTags_(tags) {
  var floodlightTags = [];
  tags.forEach(function(tag) {
    if (tag.type === 'flc' || tag.type === 'fls') {
      var params = tag.parameter || [];
      var get = function(key) {
        for (var i = 0; i < params.length; i++) { if (params[i].key === key) return params[i].value; }
        return null;
      };
      floodlightTags.push({
        name: tag.name,
        type: tag.type === 'flc' ? 'Counter' : 'Sales',
        paused: !!tag.paused,
        advertiserId: get('advertiserId'),
        groupTag: get('groupTag'),
        activityTag: get('activityTag'),
        firingTriggerId: tag.firingTriggerId || []
      });
    }
  });
  return floodlightTags;
}

function matchFloodlightToCm360_(gtmFloodlightTags, cm360Activities) {
  return gtmFloodlightTags.map(function(gtmTag) {
    var match = cm360Activities.find(function(a) {
      return a.tagString === (gtmTag.groupTag + gtmTag.activityTag) ||
             (a.groupTagString === gtmTag.groupTag && a.tagString && a.tagString.indexOf(gtmTag.activityTag) > -1);
    });
    return {
      gtmTagName: gtmTag.name,
      gtmType: gtmTag.type,
      paused: gtmTag.paused,
      groupTag: gtmTag.groupTag,
      activityTag: gtmTag.activityTag,
      advertiserId: gtmTag.advertiserId,
      matched: !!match,
      cm360Name: match ? match.name : null,
      cm360Id: match ? match.id : null,
      cm360Status: match ? match.status : null,
      issue: !match ? 'No matching CM360 Floodlight activity found for tagString: ' + gtmTag.groupTag + gtmTag.activityTag : null
    };
  });
}

/**
 * Full audit: matches GTM Floodlight tags to CM360 + returns hit counts if possible.
 */
function auditFloodlight(gtmTags, profileId, advertiserId, floodlightConfigId) {
  try {
    var gtmFloodlightTags = parseFloodlightTags_(gtmTags);
    if (!gtmFloodlightTags.length) {
      return { ok: true, hasFloodlight: false, tags: [], message: 'No Floodlight tags (flc/fls) found in this GTM container.' };
    }

    var activitiesResult = getFloodlightActivities(profileId, advertiserId);
    if (!activitiesResult.ok) throw new Error(activitiesResult.error);

    var matched = matchFloodlightToCm360_(gtmFloodlightTags, activitiesResult.data);

    var hitCountsResult = null;
    if (floodlightConfigId) {
      hitCountsResult = getFloodlightHitCounts(profileId, advertiserId, floodlightConfigId);
    }

    return {
      ok: true,
      hasFloodlight: true,
      tags: matched,
      hitCounts: (hitCountsResult && hitCountsResult.ok) ? hitCountsResult.data : [],
      hitCountsError: (hitCountsResult && !hitCountsResult.ok) ? hitCountsResult.error : null
    };
  } catch(e) { return { ok: false, error: e.message }; }
}
/* ============================================================
 GTM API — public
 ============================================================ */
function getAccounts() {
  try {
    return { ok: true, data: (gFetch(GTM_BASE + '/accounts').account || [])
      .map(function(a) { return { id: a.accountId, name: a.name }; }) };
  } catch(e) { return { ok: false, error: e.message }; }
}

function getContainers(accountId) {
  try {
    return { ok: true, data: (gFetch(GTM_BASE + '/accounts/' + accountId + '/containers').container || [])
      .map(function(c) { return { id: c.containerId, name: c.name, publicId: c.publicId }; }) };
  } catch(e) { return { ok: false, error: e.message }; }
}

function getWorkspaces(accountId, containerId) {
  try {
    return { ok: true, data: (gFetch(GTM_BASE + '/accounts/' + accountId + '/containers/' + containerId + '/workspaces').workspace || [])
      .map(function(w) { return { id: w.workspaceId, name: w.name, description: w.description || '' }; }) };
  } catch(e) { return { ok: false, error: e.message }; }
}

/* ============================================================
 GTM — private
 ============================================================ */
function getContainerData_(accountId, containerId, workspaceId) {
  var base = GTM_BASE + '/accounts/' + accountId + '/containers/' + containerId + '/workspaces/' + workspaceId;
  return {
    tags:      gFetch(base + '/tags').tag          || [],
    triggers:  gFetch(base + '/triggers').trigger  || [],
    variables: gFetch(base + '/variables').variable || []
  };
}

function parseGA4Tags_(tags, triggers) {
  var trigMap = {};
  triggers.forEach(function(t) { trigMap[t.triggerId] = t.name; });
  var configTags = [], eventTags = [];

  tags.forEach(function(tag) {
    var params = tag.parameter || [];
    var get = function(key) {
      for (var i = 0; i < params.length; i++) { if (params[i].key === key) return params[i].value; }
      return null;
    };
    if (tag.type === 'gaawc' || tag.type === 'googtag') {
      var mid = get('tagId') || get('measurementId') || get('id');
      if (mid) configTags.push({ name: tag.name, type: tag.type, measurementId: mid, paused: !!tag.paused,
        firingTriggers: (tag.firingTriggerId || []).map(function(id) { return trigMap[id]; }).filter(Boolean) });
    }
    if (tag.type === 'gaawe') {
      var evParams = [];
      params.forEach(function(p) {
        if (p.key === 'eventSettingsTable') {
          (p.list || []).forEach(function(item) {
            var kv = {};
            (item.map || []).forEach(function(m) { kv[m.key] = m.value; });
            evParams.push(kv);
          });
        }
      });
      eventTags.push({
        name: tag.name, eventName: get('eventName') || '', measurementId: get('measurementId') || '',
        paused: !!tag.paused, parameters: evParams,
        firingTriggers:   (tag.firingTriggerId  || []).map(function(id) { return trigMap[id]; }).filter(Boolean),
        blockingTriggers: (tag.blockingTriggerId || []).map(function(id) { return trigMap[id]; }).filter(Boolean)
      });
    }
  });

  var seen = {}, measurementIds = [];
  configTags.concat(eventTags).forEach(function(t) {
    if (t.measurementId && !seen[t.measurementId] && /^(G-|AW-)/.test(t.measurementId)) {
      seen[t.measurementId] = true; measurementIds.push(t.measurementId);
    }
  });
  return { configTags: configTags, eventTags: eventTags, measurementIds: measurementIds };
}

/* ============================================================
 GA4 ADMIN
 ============================================================ */
function findGA4Property_(measurementId) {
  var token = ScriptApp.getOAuthToken();
  var accounts = [];
  var accToken = null;
  do {
    var accUrl = ADM_BASE + '/accounts?pageSize=200' + (accToken ? '&pageToken=' + accToken : '');
    try {
      var accRes = JSON.parse(UrlFetchApp.fetch(accUrl, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true }).getContentText());
      accounts = accounts.concat(accRes.accounts || []);
      accToken = accRes.nextPageToken || null;
    } catch(e) { break; }
  } while (accToken);

  for (var i = 0; i < accounts.length; i++) {
    var properties = [];
    var propToken = null;
    do {
      var propUrl = ADM_BASE + '/properties?filter=parent:' + accounts[i].name + '&pageSize=200' + (propToken ? '&pageToken=' + propToken : '');
      try {
        var propRes = JSON.parse(UrlFetchApp.fetch(propUrl, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true }).getContentText());
        properties = properties.concat(propRes.properties || []);
        propToken = propRes.nextPageToken || null;
      } catch(e) { break; }
    } while (propToken);

    for (var j = 0; j < properties.length; j++) {
      var streams = [];
      try { streams = gFetch(ADM_BASE + '/' + properties[j].name + '/dataStreams').dataStreams || []; } catch(e) { continue; }
      for (var k = 0; k < streams.length; k++) {
        if (streams[k].webStreamData && streams[k].webStreamData.measurementId === measurementId) {
          return { account: accounts[i], property: properties[j], stream: streams[k], measurementId: measurementId };
        }
      }
    }
  }
  return null;
}

function buildPropertyFromId_(propertyId) {
  if (!propertyId) return null;
  if (propertyId.indexOf('properties/') === -1) propertyId = 'properties/' + propertyId;
  var token = ScriptApp.getOAuthToken();
  try {
    var propRes = UrlFetchApp.fetch(ADM_BASE + '/' + propertyId,
      { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (propRes.getResponseCode() !== 200) { Logger.log('[buildPropertyFromId_] ' + propRes.getContentText().slice(0,200)); return null; }
    var property = JSON.parse(propRes.getContentText());
    var stmRes   = UrlFetchApp.fetch(ADM_BASE + '/' + propertyId + '/dataStreams',
      { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    var streams  = [];
    try { streams = JSON.parse(stmRes.getContentText()).dataStreams || []; } catch(e) {}
    var webStream = null;
    for (var i = 0; i < streams.length; i++) { if (streams[i].webStreamData) { webStream = streams[i]; break; } }
    return {
      account: { displayName: 'Manual entry' }, property: property, stream: webStream || {},
      measurementId: (webStream && webStream.webStreamData) ? webStream.webStreamData.measurementId : ''
    };
  } catch(e) { Logger.log('[buildPropertyFromId_] ' + e.message); return null; }
}

function listAllGA4Properties() {
  var token = ScriptApp.getOAuthToken(), results = [];

  var accounts = [];
  var accToken = null;
  do {
    var accUrl = ADM_BASE + '/accounts?pageSize=200' + (accToken ? '&pageToken=' + accToken : '');
    var accRes = JSON.parse(UrlFetchApp.fetch(accUrl, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true }).getContentText());
    accounts = accounts.concat(accRes.accounts || []);
    accToken = accRes.nextPageToken || null;
  } while (accToken);

  for (var i = 0; i < accounts.length; i++) {
    var propToken = null;
    do {
      var propUrl = ADM_BASE + '/properties?filter=parent:' + accounts[i].name + '&pageSize=200' + (propToken ? '&pageToken=' + propToken : '');
      try {
        var propRes = JSON.parse(UrlFetchApp.fetch(propUrl, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true }).getContentText());
        (propRes.properties || []).forEach(function(p) {
          results.push({ accountName: accounts[i].displayName, propertyId: p.name, propertyName: p.displayName });
        });
        propToken = propRes.nextPageToken || null;
      } catch(e) { break; }
    } while (propToken);
  }
  return { ok: true, data: results };
}
/* ============================================================
 GOOGLE ADS — GTM tag parsing
 ============================================================ */
function parseGoogleAdsTags_(tags) {
  var adsTags = [];
  tags.forEach(function(tag) {
    if (tag.type === 'awct' || tag.type === 'sp') {
      var params = tag.parameter || [];
      var get = function(key) {
        for (var i = 0; i < params.length; i++) { if (params[i].key === key) return params[i].value; }
        return null;
      };
      var cs = tag.consentSettings;
      var consentStatus = cs ? (cs.consentStatus || 'notSet') : 'notSet';

      adsTags.push({
        name: tag.name,
        type: tag.type === 'awct' ? 'Conversion Tracking' : 'Remarketing',
        paused: !!tag.paused,
        conversionId: get('conversionId'),
        conversionLabel: get('conversionLabel'),
        conversionValue: get('conversionValue'),
        currencyCode: get('currencyCode'),
        orderId: get('orderId'),
        consentStatus: consentStatus,
        firingTriggerId: tag.firingTriggerId || []
      });
    }
  });
  return adsTags;
}

/**
 * Analyze Google Ads tags for common issues.
 */
function auditGoogleAdsTags_(adsTags) {
  var issues = [];

  adsTags.forEach(function(tag) {
    if (tag.type === 'Conversion Tracking') {
      if (!tag.conversionId) {
        issues.push({ severity: 'critical', title: tag.name + ' has no Conversion ID',
          detail: 'This Conversion Tracking tag is missing a Conversion ID, meaning it cannot report conversions to Google Ads.',
          fix: 'Open the tag in GTM and set a valid Conversion ID from your Google Ads account.' });
      }
      if (!tag.conversionLabel) {
        issues.push({ severity: 'warning', title: tag.name + ' has no Conversion Label',
          detail: 'Conversion Label is missing. Without it, Google Ads may not correctly attribute this conversion action.',
          fix: 'Add the Conversion Label from your Google Ads conversion action setup.' });
      }
      if (!tag.currencyCode && tag.conversionValue) {
        issues.push({ severity: 'info', title: tag.name + ' has a value but no currency code',
          detail: 'A conversion value is set (' + tag.conversionValue + ') but no currency code — Google Ads may default to account currency, which could cause reporting inconsistencies for multi-currency setups.',
          fix: 'Add an explicit currencyCode parameter (e.g. GBP, USD) to avoid ambiguity.' });
      }
    }
    if (tag.consentStatus === 'notSet') {
      issues.push({ severity: 'warning', title: tag.name + ' has no consent settings',
        detail: 'This Google Ads tag has no consent configuration. Under Consent Mode v2 / DMA requirements, Ads tags should require ad_storage, ad_user_data, and ad_personalization.',
        fix: 'In GTM, open the tag → Advanced Settings → Consent Settings → require ad_storage + ad_user_data + ad_personalization.' });
    }
    if (tag.paused) {
      issues.push({ severity: 'info', title: tag.name + ' is paused',
        detail: 'This Google Ads tag is currently paused and will not fire.',
        fix: 'Confirm this is intentional. If not, unpause the tag.' });
    }
  });

  return issues;
}

/* ============================================================
 GA4 DATA API
 ============================================================ */
function getGA4Events(propertyName) {
  var token = ScriptApp.getOAuthToken();
  var res   = UrlFetchApp.fetch(DATA_BASE + '/' + propertyName + ':runReport', {
    method: 'post',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    payload: JSON.stringify({
      dimensions: [{ name: 'eventName' }], metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
      dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
      orderBys:   [{ metric: { metricName: 'eventCount' }, desc: true }], limit: 100
    }), muteHttpExceptions: true
  });
  var code = res.getResponseCode(), text = res.getContentText();
  Logger.log('[GA4 Data] ' + propertyName + ' HTTP: ' + code);
  if (code === 403) return { error: 'GA4 Data API denied (403). Enable "Google Analytics Data API" in Cloud Console.' };
  if (code === 404) return { error: 'GA4 property not found: ' + propertyName };
  if (code !== 200) {
    var msg = 'GA4 Data API error ' + code;
    try { msg = JSON.parse(text).error.message || msg; } catch(e) {}
    return { error: msg };
  }
  var rows = JSON.parse(text).rows || [];
  Logger.log('[GA4 Data] rows: ' + rows.length);
  return rows.map(function(row) {
    return { eventName: row.dimensionValues[0].value, eventCount: parseInt(row.metricValues[0].value) || 0, users: parseInt(row.metricValues[1].value) || 0 };
  });
}

function getGA4Realtime_(propertyName) {
  try {
    var r = gFetch(DATA_BASE + '/' + propertyName + ':runRealtimeReport', {
      method: 'post',
      payload: JSON.stringify({ dimensions: [{ name: 'eventName' }, { name: 'unifiedScreenName' }], metrics: [{ name: 'eventCount' }], limit: 50 })
    });
    return (r.rows || []).map(function(row) {
      return { eventName: row.dimensionValues[0].value, page: row.dimensionValues[1].value, count: parseInt(row.metricValues[0].value) || 0 };
    });
  } catch(e) { Logger.log('[GA4 Realtime] ' + e.message); return []; }
}

function pollRealtime(propertyName) {
  try   { return { ok: true,  data: getGA4Realtime_(propertyName) }; }
  catch(e) { return { ok: false, error: e.message }; }
}

/* ============================================================
 CONSENT MODE ANALYSIS
 ============================================================ */
function extractConsentTypes_(cs) {
  if (!cs || !cs.consentType) return [];
  var types = [], ct = cs.consentType;
  if (ct.type === 'list' && ct.list) {
    ct.list.forEach(function(item) {
      if (item.type === 'map' && item.map) {
        item.map.forEach(function(m) { if ((m.key === 'consentType' || m.key === 'type') && m.value) types.push(m.value); });
      } else if (item.value) types.push(item.value);
    });
  } else if (Array.isArray(ct)) {
    ct.forEach(function(item) {
      if (typeof item === 'string') types.push(item);
      else if (item.value) types.push(item.value);
      else if (item.consentType) types.push(item.consentType);
    });
  } else if (typeof ct === 'string') types.push(ct);
  return types;
}

function analyzeConsent_(tags, triggers) {
  var trigMap = {}, consentInitIds = [];
  triggers.forEach(function(t) {
    trigMap[t.triggerId] = t;
    if (t.type === 'consentInit' || t.type === 'CONSENT_INIT') consentInitIds.push(t.triggerId);
  });

  var result = {
    hasConsentInitTag: false, hasConsentUpdateTag: false, consentInitTagNames: [],
    consentInitTriggerUsed: false, consentModeV2: false, v2TypesFound: [],
    tags: { consentNeeded: [], consentNotNeeded: [], noConsentSet: [], withWorkaround: [] },
    totalTags: tags.length, gaTagsNoConsent: [], issues: [], score: 100
  };

  tags.forEach(function(tag) {
    var cs = tag.consentSettings, params = tag.parameter || [], firingIds = tag.firingTriggerId || [];
    var isGA4 = (tag.type === 'gaawc' || tag.type === 'googtag' || tag.type === 'gaawe');

    if (tag.type === 'gconsent') {
      result.hasConsentInitTag = true; result.hasConsentUpdateTag = true;
      result.consentInitTagNames.push(tag.name);
    }
    if (firingIds.some(function(id) { return consentInitIds.indexOf(id) > -1; })) result.consentInitTriggerUsed = true;
    if (tag.type === 'html') {
      var html = '';
      params.forEach(function(p) { if (p.key === 'html') html = p.value || ''; });
      if (html.indexOf("gtag('consent'") > -1 || html.indexOf('gtag("consent"') > -1 || html.indexOf('consent_default') > -1) {
        result.hasConsentInitTag = true;
        result.consentInitTagNames.push(tag.name + ' (Custom HTML)');
      }
    }

    var status = cs ? (cs.consentStatus || 'notSet') : 'notSet';
    var consentTypes = (cs && status === 'needed') ? extractConsentTypes_(cs) : [];
    var tagEntry = { name: tag.name, type: tag.type, paused: !!tag.paused, status: status, consentTypes: consentTypes };

    consentTypes.forEach(function(t) {
      if (t === 'ad_user_data' || t === 'ad_personalization') {
        result.consentModeV2 = true;
        if (result.v2TypesFound.indexOf(t) === -1) result.v2TypesFound.push(t);
      }
    });

    if (status === 'needed') {
      result.tags.consentNeeded.push(tagEntry);
    } else if (status === 'notNeeded') {
      result.tags.consentNotNeeded.push(tagEntry);
    } else {
      var workaroundTrigger = '';
      firingIds.forEach(function(id) {
        var trig = trigMap[id];
        if (!trig) return;
        var fs = JSON.stringify(trig.filter || trig.customEventFilter || []).toLowerCase();
        if (fs.indexOf('consent') > -1 || fs.indexOf('signal') > -1 || fs.indexOf('gdpr') > -1 || fs.indexOf('cookie') > -1) {
          workaroundTrigger = trig.name;
        }
      });
      if (workaroundTrigger) { tagEntry.workaroundTrigger = workaroundTrigger; result.tags.withWorkaround.push(tagEntry); }
      else { result.tags.noConsentSet.push(tagEntry); if (isGA4) result.gaTagsNoConsent.push(tag.name); }
    }
  });

  if (!result.hasConsentInitTag && !result.consentInitTriggerUsed) {
    result.issues.push({ severity: 'critical', title: 'No Consent Mode initialization found',
      detail: 'No tag sets default consent state before other tags fire. Tags may fire without user consent, violating GDPR/DMA requirements.',
      fix: 'Add a Google Consent Mode tag (type: gconsent) with a Consent Initialization - All Pages trigger. Set analytics_storage=denied, ad_storage=denied as defaults.' });
    result.score -= 40;
  }
  if (!result.consentModeV2) {
    result.issues.push({ severity: 'warning', title: 'Consent Mode v2 not detected',
      detail: 'No ad_user_data or ad_personalization consent types found. Consent Mode v2 is required for EU DMA compliance (Google Ads requirement from March 2024).',
      fix: 'Update consent configuration to include ad_user_data and ad_personalization in both default and update calls.' });
    result.score -= 20;
  }
  if (result.gaTagsNoConsent.length > 0) {
    result.issues.push({ severity: 'critical', title: result.gaTagsNoConsent.length + ' GA4 tag(s) have no consent settings',
      detail: 'Tags with no consent settings: ' + result.gaTagsNoConsent.join(', ') + '. These tags may fire even when analytics_storage is denied.',
      fix: 'In GTM, open each tag → Advanced Settings → Consent Settings → Set to "Require additional consent" → Add analytics_storage.' });
    result.score -= Math.min(result.gaTagsNoConsent.length * 10, 30);
  }
  var otherNoConsent = result.tags.noConsentSet.filter(function(t) { return result.gaTagsNoConsent.indexOf(t.name) === -1; });
  if (otherNoConsent.length > 0) {
    result.issues.push({ severity: 'info', title: otherNoConsent.length + ' non-GA4 tag(s) have no consent settings',
      detail: 'Tags: ' + otherNoConsent.slice(0,5).map(function(t) { return t.name + ' (' + t.type + ')'; }).join(', ') + (otherNoConsent.length > 5 ? '...' : '') + '. Review if these perform tracking.',
      fix: 'Review each tag — if it does tracking or personalisation, add consent settings.' });
    result.score -= 5;
  }
  result.score = Math.max(0, result.score);
  return result;
}

/* ============================================================
 AI — system prompt
 ============================================================ */
var AI_SYSTEM = [
'You are a senior GTM / GA4 implementation auditor.',
'Analyze the GTM config and GA4 data provided.',
'Return ONLY valid JSON — no markdown, no text outside the JSON object.',
'',
'CRITICAL RULES — BE SPECIFIC:',
'- title: ALWAYS include the exact tag/event name. BAD: "Event not lowercase". GOOD: "purchase event name uses uppercase: should be purchase not Purchase"',
'- detail: ALWAYS include exact names, values, IDs from the data. Explain what was found and why it is a problem.',
'- tag: ALWAYS use the exact GTM tag name from GTM_EVENT_TAGS or GTM_CONFIG_TAGS.',
'- For missing params: name EXACTLY which params are missing for which event.',
'- For blocking triggers: name EXACTLY which trigger blocks which tag.',
'- For naming issues: show the ACTUAL event name and what is wrong.',
'- For MID issues: show the ACTUAL IDs that conflict.',
'',
'Required JSON structure:',
'{',
'  "score": <integer 0-100>,',
'  "grade": "<A|B|C|D|F>",',
'  "summary": "<2-3 sentence overview with specific findings>",',
'  "measurementIds": { "consistent": <bool>, "gtmIds": ["<exact IDs>"], "ga4Id": "<id or null>", "issues": ["<specific strings>"] },',
'  "events": [{',
'    "name": "<exact event name>",',
'    "inGTM": <bool>, "inGA4Last30Days": <bool>, "inGA4Realtime": <bool>, "ga4Count": <number>,',
'    "namingOk": <bool>, "namingIssue": "<specific e.g. uses uppercase: AddToCart should be add_to_cart>",',
'    "status": "<ok|warning|error>",',
'    "problems": ["<specific problem with exact names>"],',
'    "params": { "configured": ["<exact param names>"], "missingRequired": ["<exact missing param names>"], "notes": "<specific string>" }',
'  }],',
'  "issues": [{',
'    "severity": "<critical|warning|info>",',
'    "category": "<naming|params|missing|trigger|mid|config|duplicate|consent>",',
'    "title": "<specific title with exact tag/event name>",',
'    "detail": "<specific description with exact names and values>",',
'    "tag": "<exact GTM tag name>",',
'    "fix": "<specific actionable fix with exact values>",',
'    "snippet": "<code example or null>"',
'  }],',
'  "positives": ["<specific findings with exact names>"],',
'  "recommendations": [{ "priority": "<high|medium|low>", "title": "<specific>", "detail": "<specific>" }]',
'}',
'',
'IMPORTANT:',
'- All array values must be plain strings, never objects.',
'- GA4 Config tags (gaawc/googtag) do NOT fire as named events — never flag them as missing from GA4.',
'- Only flag gaawe (GA4 Event) tags as missing from GA4_EVENTS_30D.',
'- Be as specific as possible using exact names from the data.'
].join('\n');

/* ============================================================
 AI — compact prompt builder
 ============================================================ */
function buildPrompt_(d) {
  var lines = [];
  lines.push('GTM_CONFIG_TAGS:' + JSON.stringify((d.configTags || []).map(function(t) {
    return { name: t.name, mid: t.measurementId, paused: t.paused };
  })));
  lines.push('GTM_EVENT_TAGS:' + JSON.stringify((d.eventTags || []).slice(0,40).map(function(t) {
    return { name: t.name, event: t.eventName, paused: t.paused, params: (t.parameters || []).slice(0,6), firing: t.firingTriggers, blocking: t.blockingTriggers };
  })));
  lines.push('GTM_TRIGGERS:' + JSON.stringify((d.triggers || []).slice(0,15).map(function(t) {
    return { name: t.name, type: t.type, filters: (t.filter || []).length };
  })));
  lines.push('GA4_EVENTS_30D:' + JSON.stringify((d.ga4Events || []).slice(0,25).map(function(e) {
    return { event: e.eventName, count: e.eventCount, users: e.users };
  })));
  lines.push('GA4_REALTIME:' + JSON.stringify((d.ga4Realtime || []).slice(0,10).map(function(e) {
    return { event: e.eventName, count: e.count };
  })));
  lines.push('GA4_PROPERTY:' + JSON.stringify(d.ga4Property ? {
    name: d.ga4Property.property.displayName, id: d.ga4Property.property.name, mid: d.ga4Property.measurementId
  } : null));
  lines.push('CONSENT_MODE:' + JSON.stringify(d.consent ? {
    hasInitTag: d.consent.hasConsentInitTag, v2: d.consent.consentModeV2, v2Types: d.consent.v2TypesFound,
    gaTagsNoConsent: d.consent.gaTagsNoConsent, score: d.consent.score
  } : null));
  lines.push('');
  lines.push('AUDIT CHECKLIST:');
  lines.push('1.  Measurement ID consistent across GTM tags vs GA4 property?');
  lines.push('2.  Each GTM GA4 Event tag (gaawe) visible in GA4_EVENTS_30D?');
  lines.push('3.  Events in GA4_EVENTS_30D with no GTM tag?');
  lines.push('4.  GA4 naming rules: lowercase, underscores only, max 40 chars?');
  lines.push('5.  Required params: purchase needs currency+value+items');
  lines.push('6.  Paused tags still appearing in GA4?');
  lines.push('7.  Duplicate events per pageview?');
  lines.push('8.  Blocking triggers preventing fires?');
  lines.push('9.  Triggers too broad?');
  lines.push('10. Consent Mode: is init present? GA4 tags require analytics_storage?');
  lines.push('11. Consent Mode v2: ad_user_data + ad_personalization configured?');
  return lines.join('\n');
}

/* ============================================================
 GROQ API CALL (with retry + auto-downgrade)
 ============================================================ */
function callGroq_(apiKey, model, prompt) {
  Logger.log('[Groq] Starting. Model: ' + model);
  var body = {
    model: model || 'llama-3.1-8b-instant',
    messages: [{ role: 'system', content: AI_SYSTEM }, { role: 'user', content: prompt }],
    response_format: { type: 'json_object' }, temperature: 0.1, max_tokens: 3000
  };
  var maxAttempts = 3;
  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    Logger.log('[Groq] Attempt ' + attempt + ' model: ' + body.model);
    var res  = UrlFetchApp.fetch(GROQ_URL, {
      method: 'post', headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      payload: JSON.stringify(body), muteHttpExceptions: true
    });
    var code = res.getResponseCode(), text = res.getContentText();
    Logger.log('[Groq] HTTP ' + code);
    if ((code === 503 || code === 500) && attempt < maxAttempts) { Utilities.sleep(attempt * 3000); continue; }
    if (code === 413 && attempt < maxAttempts) { body.model = 'llama-3.1-8b-instant'; body.max_tokens = 2500; Utilities.sleep(1000); continue; }
    if (code === 429) {
      var wait = 60;
      try { var m = text.match(/try again in (\d+)/i); if (m) wait = parseInt(m[1]) + 2; } catch(e) {}
      throw new Error('Groq rate limit. Wait ' + wait + ' seconds and try again.');
    }
    if (code !== 200) {
      var errMsg = 'Groq error (' + code + ')';
      try { errMsg += ': ' + (JSON.parse(text).error.message || text.slice(0,200)); } catch(e) { errMsg += ': ' + text.slice(0,200); }
      throw new Error(errMsg);
    }
    var outer;
    try { outer = JSON.parse(text); } catch(e) { throw new Error('Cannot parse Groq response: ' + text.slice(0,200)); }
    var content = '';
    try { content = outer.choices[0].message.content; } catch(e) { throw new Error('Unexpected Groq response shape'); }
    var clean = content.replace(/^\s*$/,'').trim();
    try {
      var parsed = JSON.parse(clean);
      Logger.log('[Groq] Success. Score: ' + (parsed.score || 'N/A'));
      return parsed;
    } catch(e) { throw new Error('Groq returned non-JSON: ' + clean.slice(0,300)); }
  }
  throw new Error('Groq failed after ' + maxAttempts + ' attempts');
}

/* ============================================================
 MAIN ANALYSIS
 ============================================================ */
function runAnalysis(params) {
  var sid = params.sessionId || 'default';
  try {
    setProgress_(sid, 1, 'Analysis started');

    setProgress_(sid, 2, 'Connecting to GTM API...');
    var raw;
    try {
      raw = getContainerData_(params.accountId, params.containerId, params.workspaceId);
      setProgress_(sid, 3, 'GTM loaded: ' + raw.tags.length + ' tags | ' + raw.triggers.length + ' triggers | ' + raw.variables.length + ' variables');
    } catch(e) { setError_(sid, 'GTM API error: ' + e.message); return { ok: false, error: 'GTM API error: ' + e.message }; }

    setProgress_(sid, 4, 'Parsing GA4 tags...');
    var parsed = parseGA4Tags_(raw.tags, raw.triggers);
    setProgress_(sid, 5, 'GA4 Config: ' + parsed.configTags.length + ' | GA4 Events: ' + parsed.eventTags.length + ' | Measurement IDs: ' + (parsed.measurementIds.join(', ') || 'none'));

    setProgress_(sid, 5, 'Analysing Consent Mode...');
    var consent = analyzeConsent_(raw.tags, raw.triggers);
    setProgress_(sid, 5, 'Consent: init=' + (consent.hasConsentInitTag ? 'YES' : 'NO') + ' | v2=' + (consent.consentModeV2 ? 'YES' : 'NO') + ' | tags without consent: ' + consent.tags.noConsentSet.length + ' | score: ' + consent.score + '/100');

    // Floodlight (GTM-side parsing only — CM360 matching happens separately via auditFloodlight())
    var floodlightTags = parseFloodlightTags_(raw.tags);
    if (floodlightTags.length) {
      setProgress_(sid, 5, 'Floodlight tags found: ' + floodlightTags.length + ' (use CM360 tab to match & get hit counts)');
    }
    var googleAdsTags = parseGoogleAdsTags_(raw.tags);
    var googleAdsIssues = auditGoogleAdsTags_(googleAdsTags);
    if (googleAdsTags.length) {
      setProgress_(sid, 5, 'Google Ads tags found: ' + googleAdsTags.length + ' (' + googleAdsIssues.length + ' issue(s))');
    }

    var ga4Property = null, ga4Events = [], ga4Realtime = [], ga4DataError = null;
    if (params.ga4PropertyId) {
      setProgress_(sid, 6, 'Using manual GA4 property: ' + params.ga4PropertyId);
      try {
        ga4Property = buildPropertyFromId_(params.ga4PropertyId);
        setProgress_(sid, 7, ga4Property ? 'GA4 property loaded: ' + ga4Property.property.displayName : 'WARNING: Could not load property ' + params.ga4PropertyId);
      } catch(e) { setProgress_(sid, 7, 'WARNING: ' + e.message); }
    } else if (parsed.measurementIds.length > 0) {
      setProgress_(sid, 6, 'Auto-searching GA4 property for: ' + parsed.measurementIds[0] + ' (tip: enter Property ID manually to skip slow search)');
      try {
        for (var i = 0; i < parsed.measurementIds.length; i++) {
          setProgress_(sid, 6, 'Searching: ' + parsed.measurementIds[i] + '...');
          ga4Property = findGA4Property_(parsed.measurementIds[i]);
          if (ga4Property) break;
        }
        setProgress_(sid, 7, ga4Property ? 'GA4 found: ' + ga4Property.property.displayName + ' (' + ga4Property.measurementId + ')' : 'WARNING: No matching GA4 property found. Enter Property ID manually.');
      } catch(e) { setProgress_(sid, 7, 'WARNING GA4 search: ' + e.message); }
    } else {
      setProgress_(sid, 6, 'No GA4 measurement IDs in GTM tags');
    }

    if (ga4Property) {
      setProgress_(sid, 8, 'Fetching GA4 event data (last 30 days)...');
      try {
        var evResult = getGA4Events(ga4Property.property.name);
        if (evResult && evResult.error) { ga4DataError = evResult.error; setProgress_(sid, 8, 'WARNING GA4: ' + evResult.error); }
        else if (Array.isArray(evResult)) {
          ga4Events = evResult;
          setProgress_(sid, 8, 'GA4 events: ' + ga4Events.length + ' (top: ' + ga4Events.slice(0,3).map(function(e){return e.eventName;}).join(', ') + ')');
        }
      } catch(e) { ga4DataError = e.message; setProgress_(sid, 8, 'WARNING GA4 error: ' + e.message); }
      setProgress_(sid, 9, 'Fetching GA4 realtime...');
      try {
        ga4Realtime = getGA4Realtime_(ga4Property.property.name);
        setProgress_(sid, 9, 'Realtime events: ' + ga4Realtime.length);
      } catch(e) { setProgress_(sid, 9, 'Realtime skipped: ' + e.message); }
    }

    var aiResult = null;
    if (params.apiKey) {
      var model = params.model || 'llama-3.1-8b-instant';
      setProgress_(sid, 10, 'Building AI prompt...');
      var prompt = buildPrompt_({ configTags: parsed.configTags, eventTags: parsed.eventTags, triggers: raw.triggers, ga4Events: ga4Events, ga4Realtime: ga4Realtime, ga4Property: ga4Property, consent: consent });
      setProgress_(sid, 10, 'Calling Groq AI (model: ' + model + ')...');
      try {
        aiResult = callGroq_(params.apiKey, model, prompt);
        setProgress_(sid, 11, 'AI complete — Score: ' + (aiResult ? aiResult.score : 'N/A') + ' | Grade: ' + (aiResult ? aiResult.grade : 'N/A') + ' | Issues: ' + (aiResult && aiResult.issues ? aiResult.issues.length : 0));
      } catch(e) {
        setProgress_(sid, 11, 'WARNING AI failed: ' + e.message + ' — showing results without AI');
       var partial = { ok: true, aiError: e.message, gtm: { tags: raw.tags, triggers: raw.triggers, variables: raw.variables, configTags: parsed.configTags, eventTags: parsed.eventTags, measurementIds: parsed.measurementIds, floodlightTags: floodlightTags, googleAdsTags: googleAdsTags }, consent: consent, googleAdsIssues: googleAdsIssues, ga4Property: ga4Property, ga4Events: ga4Events, ga4Realtime: ga4Realtime, ga4DataError: ga4DataError, aiResult: null };
        setDone_(sid, partial); return partial;
      }
    } else { setProgress_(sid, 10, 'No Groq API key — skipping AI'); }

    setProgress_(sid, 12, 'Analysis complete!');
   var result = { ok: true, gtm: { tags: raw.tags, triggers: raw.triggers, variables: raw.variables, configTags: parsed.configTags, eventTags: parsed.eventTags, measurementIds: parsed.measurementIds, floodlightTags: floodlightTags, googleAdsTags: googleAdsTags }, consent: consent, googleAdsIssues: googleAdsIssues, ga4Property: ga4Property, ga4Events: ga4Events, ga4Realtime: ga4Realtime, ga4DataError: ga4DataError, aiResult: aiResult };
    setDone_(sid, result);
    return result;

  } catch(e) {
    var fatal = 'Fatal error: ' + e.message;
    Logger.log('[runAnalysis] ' + fatal);
    setError_(sid, fatal);
    return { ok: false, error: fatal };
  }
}
/* ============================================================
 EXPORT TO GOOGLE SHEETS
 ============================================================ */
function exportToSheet(auditData) {
  try {
    var ss = SpreadsheetApp.create('Audit M8 Report — ' + new Date().toLocaleDateString('en-GB') + ' ' + new Date().toLocaleTimeString('en-GB'));
    var ai = auditData.aiResult || {};
    var gtm = auditData.gtm || {};
    var consent = auditData.consent || {};

    // --- SUMMARY TAB ---
    var summarySheet = ss.getSheets()[0];
    summarySheet.setName('Summary');
    summarySheet.getRange('A1').setValue('Audit M8 Report').setFontSize(16).setFontWeight('bold');
    summarySheet.getRange('A2').setValue('Generated: ' + new Date().toLocaleString());
    var row = 4;
    var summaryRows = [
      ['Metric', 'Value'],
      ['AI Score', (ai.score || 'N/A') + ' / 100'],
      ['Grade', ai.grade || 'N/A'],
      ['Summary', ai.summary || 'N/A'],
      ['Total GTM Tags', gtm.tags ? gtm.tags.length : 0],
      ['Triggers', gtm.triggers ? gtm.triggers.length : 0],
      ['Variables', gtm.variables ? gtm.variables.length : 0],
      ['GA4 Config Tags', gtm.configTags ? gtm.configTags.length : 0],
      ['GA4 Event Tags', gtm.eventTags ? gtm.eventTags.length : 0],
      ['Measurement IDs', (gtm.measurementIds || []).join(', ')],
      ['Consent Score', (consent.score || 'N/A') + ' / 100'],
      ['Consent Init Tag', consent.hasConsentInitTag ? 'Yes' : 'No'],
      ['Consent Mode v2', consent.consentModeV2 ? 'Yes' : 'No'],
      ['Floodlight Tags', (gtm.floodlightTags || []).length],
      ['Google Ads Tags', (gtm.googleAdsTags || []).length],
      ['GA4 Property', auditData.ga4Property ? auditData.ga4Property.property.displayName : 'Not found']
    ];
    summarySheet.getRange(row, 1, summaryRows.length, 2).setValues(summaryRows);
    summarySheet.getRange(row, 1, 1, 2).setFontWeight('bold').setBackground('#f0f0f0');
    summarySheet.autoResizeColumns(1, 2);

    // --- EVENTS TAB ---
    if (ai.events && ai.events.length) {
      var evSheet = ss.insertSheet('Events');
      var evHeader = ['Event Name', 'In GTM', 'In GA4 (30d)', 'GA4 Count', 'Naming OK', 'Naming Issue', 'Status', 'Problems'];
      var evRows = [evHeader];
      ai.events.forEach(function(e) {
        evRows.push([
          e.name || '', e.inGTM ? 'Yes' : 'No', e.inGA4Last30Days ? 'Yes' : 'No',
          e.ga4Count || 0, e.namingOk ? 'Yes' : 'No', e.namingIssue || '',
          e.status || '', (e.problems || []).join('; ')
        ]);
      });
      evSheet.getRange(1, 1, evRows.length, evHeader.length).setValues(evRows);
      evSheet.getRange(1, 1, 1, evHeader.length).setFontWeight('bold').setBackground('#f0f0f0');
      evSheet.autoResizeColumns(1, evHeader.length);
    }

    // --- ISSUES TAB ---
    if (ai.issues && ai.issues.length) {
      var isSheet = ss.insertSheet('Issues');
      var isHeader = ['Severity', 'Category', 'Title', 'Detail', 'Tag', 'Fix'];
      var isRows = [isHeader];
      ai.issues.forEach(function(is) {
        isRows.push([is.severity || '', is.category || '', is.title || '', is.detail || '', is.tag || '', is.fix || '']);
      });
      isSheet.getRange(1, 1, isRows.length, isHeader.length).setValues(isRows);
      isSheet.getRange(1, 1, 1, isHeader.length).setFontWeight('bold').setBackground('#f0f0f0');
      isSheet.autoResizeColumns(1, isHeader.length);
    }

    // --- CONSENT TAB ---
    if (consent.tags) {
      var csSheet = ss.insertSheet('Consent');
      var csHeader = ['Tag Name', 'Type', 'Status', 'Paused', 'Consent Types'];
      var csRows = [csHeader];
      var allTags = []
        .concat(consent.tags.consentNeeded || [])
        .concat(consent.tags.withWorkaround || [])
        .concat(consent.tags.noConsentSet || [])
        .concat(consent.tags.consentNotNeeded || []);
      allTags.forEach(function(t) {
        csRows.push([t.name || '', t.type || '', t.status || '', t.paused ? 'Yes' : 'No', (t.consentTypes || []).join(', ')]);
      });
      csSheet.getRange(1, 1, csRows.length, csHeader.length).setValues(csRows);
      csSheet.getRange(1, 1, 1, csHeader.length).setFontWeight('bold').setBackground('#f0f0f0');
      csSheet.autoResizeColumns(1, csHeader.length);
    }

    // --- FLOODLIGHT TAB ---
    if (gtm.floodlightTags && gtm.floodlightTags.length) {
      var flSheet = ss.insertSheet('Floodlight');
      var flHeader = ['Tag Name', 'Type', 'Group Tag', 'Activity Tag', 'Advertiser ID', 'Paused'];
      var flRows = [flHeader];
      gtm.floodlightTags.forEach(function(t) {
        flRows.push([t.name || '', t.type || '', t.groupTag || '', t.activityTag || '', t.advertiserId || '', t.paused ? 'Yes' : 'No']);
      });
      flSheet.getRange(1, 1, flRows.length, flHeader.length).setValues(flRows);
      flSheet.getRange(1, 1, 1, flHeader.length).setFontWeight('bold').setBackground('#f0f0f0');
      flSheet.autoResizeColumns(1, flHeader.length);
    }

    // --- GOOGLE ADS TAB ---
    if (gtm.googleAdsTags && gtm.googleAdsTags.length) {
      var gaSheet = ss.insertSheet('Google Ads');
      var gaHeader = ['Tag Name', 'Type', 'Conversion ID', 'Label', 'Value', 'Currency', 'Consent Status', 'Paused'];
      var gaRows = [gaHeader];
      gtm.googleAdsTags.forEach(function(t) {
        gaRows.push([t.name || '', t.type || '', t.conversionId || '', t.conversionLabel || '', t.conversionValue || '', t.currencyCode || '', t.consentStatus || '', t.paused ? 'Yes' : 'No']);
      });
      gaSheet.getRange(1, 1, gaRows.length, gaHeader.length).setValues(gaRows);
      gaSheet.getRange(1, 1, 1, gaHeader.length).setFontWeight('bold').setBackground('#f0f0f0');
      gaSheet.autoResizeColumns(1, gaHeader.length);
    }

    // --- GA4 30-DAY EVENTS TAB ---
    if (auditData.ga4Events && auditData.ga4Events.length) {
      var g4Sheet = ss.insertSheet('GA4 30d');
      var g4Header = ['Event Name', 'Count (30d)', 'Users'];
      var g4Rows = [g4Header];
      auditData.ga4Events.forEach(function(e) {
        g4Rows.push([e.eventName || '', e.eventCount || 0, e.users || 0]);
      });
      g4Sheet.getRange(1, 1, g4Rows.length, g4Header.length).setValues(g4Rows);
      g4Sheet.getRange(1, 1, 1, g4Header.length).setFontWeight('bold').setBackground('#f0f0f0');
      g4Sheet.autoResizeColumns(1, g4Header.length);
    }

    return { ok: true, url: ss.getUrl() };
  } catch(e) {
    Logger.log('[exportToSheet] ' + e.message);
    return { ok: false, error: e.message };
  }
}
/* ============================================================
 EXPORT CM360 FLOODLIGHT RESULTS TO SHEETS (standalone)
 ============================================================ */
function exportCm360ToSheet(profileName, advertiserName, activities, hitCounts) {
  try {
    var ss = SpreadsheetApp.create('CM360 Floodlight — ' + advertiserName + ' — ' + new Date().toLocaleDateString('en-GB'));
    var sheet = ss.getSheets()[0];
    sheet.setName('Floodlight Activities');

    sheet.getRange('A1').setValue('CM360 Floodlight Report').setFontSize(16).setFontWeight('bold');
    sheet.getRange('A2').setValue('Profile: ' + (profileName || '—'));
    sheet.getRange('A3').setValue('Advertiser: ' + (advertiserName || '—'));
    sheet.getRange('A4').setValue('Generated: ' + new Date().toLocaleString());

    var byActivityId = {};
    (hitCounts || []).forEach(function(row) {
      var id = row['Activity ID'];
      var clicks = parseFloat(row['Click-through Conversions'] || 0);
      var views = parseFloat(row['View-through Conversions'] || 0);
      byActivityId[id] = clicks + views;
    });

    var row = 6;
    var header = ['Activity Name', 'Tag String', 'Type', 'Status', 'Counting Method', 'Hits (30d)'];
    var rows = [header];
    (activities || []).forEach(function(a) {
      rows.push([
        a.name || '', a.tagString || '', a.floodlightTagType || '', a.status || '',
        a.countingMethod || '', (byActivityId[a.id] !== undefined ? byActivityId[a.id] : '—')
      ]);
    });
    sheet.getRange(row, 1, rows.length, header.length).setValues(rows);
    sheet.getRange(row, 1, 1, header.length).setFontWeight('bold').setBackground('#f0f0f0');
    sheet.autoResizeColumns(1, header.length);

    return { ok: true, url: ss.getUrl() };
  } catch(e) {
    Logger.log('[exportCm360ToSheet] ' + e.message);
    return { ok: false, error: e.message };
  }
}
/* ============================================================
 GOOGLE ADS — OAuth2 Service (separate identity, mirrors CM360)
 ============================================================ */
var ADS_API_BASE = 'https://googleads.googleapis.com/v17';

function getAdsService_() {
  var props = PropertiesService.getScriptProperties();
  return OAuth2.createService('googleAds')
    .setAuthorizationBaseUrl('https://accounts.google.com/o/oauth2/auth')
    .setTokenUrl('https://oauth2.googleapis.com/token')
    .setClientId(props.getProperty('ADS_CLIENT_ID'))
    .setClientSecret(props.getProperty('ADS_CLIENT_SECRET'))
    .setCallbackFunction('authCallbackAds')
    .setPropertyStore(props)
    .setScope('https://www.googleapis.com/auth/adwords')
    .setParam('access_type', 'offline')
    .setParam('prompt', 'consent');
}

function authorizeAds() {
  var service = getAdsService_();
  if (service.hasAccess()) {
    Logger.log('Already authorized.');
  } else {
    Logger.log('Open this URL and authorize:\n' + service.getAuthorizationUrl());
  }
}

function authCallbackAds(request) {
  var service = getAdsService_();
  var isAuthorized = service.handleCallback(request);
  return HtmlService.createHtmlOutput(isAuthorized ? 'Success! Google Ads authorized. Close this tab.' : 'Denied.');
}

function resetAdsAuth() {
  getAdsService_().reset();
}

/* ============================================================
 GOOGLE ADS — Generic query fetch
 ============================================================ */
function adsFetch_(customerId, gaqlQuery) {
  var service = getAdsService_();
  if (!service.hasAccess()) throw new Error('Google Ads not authorized. Run authorizeAds() first.');

  var devToken = PropertiesService.getScriptProperties().getProperty('ADS_DEV_TOKEN');
  var url = ADS_API_BASE + '/customers/' + customerId + '/googleAds:search';

  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: {
      Authorization: 'Bearer ' + service.getAccessToken(),
      'developer-token': devToken,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify({ query: gaqlQuery }),
    muteHttpExceptions: true
  });

  var code = res.getResponseCode(), text = res.getContentText();
  if (code < 200 || code >= 300) {
    var msg = 'Google Ads API error ' + code;
    try { msg = JSON.parse(text).error.message || msg; } catch(e) {}
    throw new Error(msg);
  }
  try { return JSON.parse(text); } catch(e) { return { results: [] }; }
}

/* ============================================================
 GOOGLE ADS — Conversion Actions (mirrors CM360 Floodlight activities)
 ============================================================ */
function getAdsConversionActions(customerId) {
  try {
    var query = "SELECT conversion_action.id, conversion_action.name, " +
      "conversion_action.status, conversion_action.type, " +
      "conversion_action.category " +
      "FROM conversion_action " +
      "WHERE conversion_action.status != 'REMOVED'";

    var r = adsFetch_(customerId, query);
    var results = (r.results || []).map(function(row) {
      var ca = row.conversionAction || {};
      return {
        id: ca.id, name: ca.name, status: ca.status,
        type: ca.type, category: ca.category
      };
    });
    return { ok: true, data: results };
  } catch(e) { return { ok: false, error: e.message }; }
}

/* ============================================================
 GOOGLE ADS — 30-day conversion counts (mirrors Floodlight hit counts)
 ============================================================ */
function getAdsConversionCounts30d(customerId) {
  try {
    var query = "SELECT conversion_action.id, conversion_action.name, " +
      "metrics.conversions, metrics.conversions_value " +
      "FROM conversion_action " +
      "WHERE segments.date DURING LAST_30_DAYS " +
      "AND conversion_action.status != 'REMOVED'";

    var r = adsFetch_(customerId, query);
    var results = (r.results || []).map(function(row) {
      var ca = row.conversionAction || {};
      var m = row.metrics || {};
      return {
        id: ca.id, name: ca.name,
        conversions: parseFloat(m.conversions || 0),
        conversionsValue: parseFloat(m.conversionsValue || 0)
      };
    });
    return { ok: true, data: results };
  } catch(e) { return { ok: false, error: e.message }; }
}

/* ============================================================
 GOOGLE ADS — Match GTM tags to real conversion actions + counts
 ============================================================ */
function auditGoogleAdsConversions(gtmAdsTags, customerId) {
  try {
    var actionsResult = getAdsConversionActions(customerId);
    if (!actionsResult.ok) throw new Error(actionsResult.error);

    var countsResult = getAdsConversionCounts30d(customerId);
    var countsById = {};
    if (countsResult.ok) {
      countsResult.data.forEach(function(c) { countsById[c.id] = c; });
    }

    var matched = gtmAdsTags.map(function(tag) {
      // conversionId in GTM tags is the AW-XXXXXXX account ID, not the conversion action ID.
      // Conversion Label often maps loosely to conversion action name — match by label/name similarity.
      var match = actionsResult.data.find(function(a) {
        return tag.conversionLabel && a.name && a.name.indexOf(tag.conversionLabel) > -1;
      });
      var counts = match ? countsById[match.id] : null;

      return {
        gtmTagName: tag.name,
        conversionId: tag.conversionId,
        conversionLabel: tag.conversionLabel,
        matched: !!match,
        adsActionName: match ? match.name : null,
        adsActionStatus: match ? match.status : null,
        conversions30d: counts ? counts.conversions : null,
        conversionsValue30d: counts ? counts.conversionsValue : null,
        issue: !match ? 'No matching Google Ads conversion action found for label: ' + (tag.conversionLabel || '(none)') : null
      };
    });

    return { ok: true, data: matched };
  } catch(e) { return { ok: false, error: e.message }; }
}

/* ============================================================
 DEBUG HELPERS
 ============================================================ */
function debugGA4DataAPI() {
  var token = ScriptApp.getOAuthToken(), log = ['=== GA4 Data API Debug ===', 'Token length: ' + token.length];
  var accounts = JSON.parse(UrlFetchApp.fetch(ADM_BASE + '/accounts', { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true }).getContentText()).accounts || [];
  log.push('Accounts: ' + accounts.length);
  for (var i = 0; i < Math.min(accounts.length, 10); i++) {
    var props = JSON.parse(UrlFetchApp.fetch(ADM_BASE + '/properties?filter=parent:' + accounts[i].name, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true }).getContentText()).properties || [];
    if (!props.length) continue;
    log.push('\nAccount: ' + accounts[i].displayName + ' | Testing: ' + props[0].name);
    var dr = UrlFetchApp.fetch(DATA_BASE + '/' + props[0].name + ':runReport', {
      method: 'post', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      payload: JSON.stringify({ dimensions: [{ name: 'eventName' }], metrics: [{ name: 'eventCount' }], dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }], limit: 3 }), muteHttpExceptions: true
    });
    log.push('Data API HTTP: ' + dr.getResponseCode());
    log.push('Response: ' + dr.getContentText().slice(0,300));
    if (dr.getResponseCode() === 403) log.push('FIX: console.cloud.google.com/apis/library/analyticsdata.googleapis.com');
    break;
  }
  Logger.log(log.join('\n'));
}
function debugGetCm360Profiles() {
  Logger.log(JSON.stringify(getCm360Profiles(), null, 2));
}

function debugCm360Token() {
  var service = getCm360Service();
  Logger.log('hasAccess: ' + service.hasAccess());
  var token = service.getAccessToken();
  Logger.log('Token length: ' + (token ? token.length : 'NULL/EMPTY'));
}

function debugFloodlightHitCounts() {
  var result = getFloodlightHitCounts('10871023', '13998630', '13998630');
  Logger.log(JSON.stringify(result, null, 2));
}
function debugFloodlightReportStepByStep() {
  var profileId = '10871023';
  var advertiserId = '13998630';
  var floodlightConfigId = '13998630';

  Logger.log('Step 1: Creating report...');
  var created = createFloodlightReport_(profileId, advertiserId, floodlightConfigId);
  Logger.log('Report created. ID: ' + created.id);
  Logger.log(JSON.stringify(created, null, 2));

  Logger.log('Step 2: Running report...');
  var ran = runFloodlightReport_(profileId, created.id);
  Logger.log('Run response:');
  Logger.log(JSON.stringify(ran, null, 2));

  Logger.log('Step 3: Checking file status (one-time check, not polling)...');
  var url = CM360_BASE + '/userprofiles/' + profileId + '/reports/' + created.id + '/files/' + ran.id;
  var file = cm360Fetch_(url);
  Logger.log('File status: ' + file.status);
  Logger.log(JSON.stringify(file, null, 2));
}

function debugAuditFloodlight() {
  // Example test — replace with real GTM tags array when testing
  var result = auditFloodlight([], '10871023', '13998630', '13998630');
  Logger.log(JSON.stringify(result, null, 2));
}
function debugGA4AccountsRaw() {
  var token = ScriptApp.getOAuthToken();
  var res = UrlFetchApp.fetch('https://analyticsadmin.googleapis.com/v1beta/accounts', {
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  Logger.log('Code: ' + res.getResponseCode());
  Logger.log('Body: ' + res.getContentText());
}
function debugCheckSheetsAccess() {
  try {
    var ss = SpreadsheetApp.create('test-permission-check');
    Logger.log('SUCCESS: ' + ss.getUrl());
    DriveApp.getFileById(ss.getId()).setTrashed(true); // cleanup
  } catch(e) {
    Logger.log('FAILED: ' + e.message);
  }
}
function freshSheetsTest_v2() {
  var ss = SpreadsheetApp.create('fresh-test-v2');
  Logger.log('Created: ' + ss.getUrl());
}
function debugGA4AfterRevoke() {
  var token = ScriptApp.getOAuthToken();
  var res = UrlFetchApp.fetch('https://analyticsadmin.googleapis.com/v1beta/accounts', {
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  Logger.log('Code: ' + res.getResponseCode());
  Logger.log('Body: ' + res.getContentText().slice(0, 500));
}
function fullReauthCheck() {
  Logger.log('--- GTM ---');
  try { Logger.log(JSON.stringify(getAccounts())); } catch(e) { Logger.log('GTM failed: ' + e.message); }

  Logger.log('--- GA4 Admin ---');
  try {
    var token = ScriptApp.getOAuthToken();
    var res = UrlFetchApp.fetch('https://analyticsadmin.googleapis.com/v1beta/accounts', {
      headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true
    });
    Logger.log('GA4 Admin code: ' + res.getResponseCode());
  } catch(e) { Logger.log('GA4 Admin failed: ' + e.message); }

  Logger.log('--- Sheets ---');
  try {
    var ss = SpreadsheetApp.create('reauth-check');
    Logger.log('Sheets OK: ' + ss.getUrl());
    DriveApp.getFileById(ss.getId()).setTrashed(true);
  } catch(e) { Logger.log('Sheets failed: ' + e.message); }
}
function forceFullAuthV3() {
  Logger.log('Testing GTM...');
  var token = ScriptApp.getOAuthToken();
  var res1 = UrlFetchApp.fetch('https://tagmanager.googleapis.com/tagmanager/v2/accounts', {
    headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true
  });
  Logger.log('GTM code: ' + res1.getResponseCode());

  Logger.log('Testing GA4 Admin...');
  var res2 = UrlFetchApp.fetch('https://analyticsadmin.googleapis.com/v1beta/accounts', {
    headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true
  });
  Logger.log('GA4 code: ' + res2.getResponseCode());

  Logger.log('Testing Sheets...');
  var ss = SpreadsheetApp.create('authtest-v3');
  Logger.log('Sheets OK: ' + ss.getUrl());
}
function checkTokenScopes() {
  var token = ScriptApp.getOAuthToken();
  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + token, {
    muteHttpExceptions: true
  });
  Logger.log(res.getContentText());
}
function checkManifestScopes() {
  // This will just confirm the script can see itself — not scopes directly, but sanity check
  Logger.log('Script ID: ' + ScriptApp.getScriptId());
}
function compareTokens() {
  var scriptToken = ScriptApp.getOAuthToken();
  var cm360Token = getCm360Service().getAccessToken();
  Logger.log('Script token starts: ' + scriptToken.substring(0, 25));
  Logger.log('CM360 token starts: ' + cm360Token.substring(0, 25));
  Logger.log('Are they equal? ' + (scriptToken === cm360Token));
}
function debugListGA4Properties() {
  var result = listAllGA4Properties();
  Logger.log(JSON.stringify(result, null, 2).slice(0, 1000));
}function debugAdsConversionActions() {
  var customerId = 'YOUR_10_DIGIT_CUSTOMER_ID'; // digits only, no dashes, e.g. 1234567890
  var result = getAdsConversionActions(customerId);
  Logger.log(JSON.stringify(result, null, 2));
}
function debugAdsRaw() {
  var service = getAdsService_();
  var devToken = PropertiesService.getScriptProperties().getProperty('ADS_DEV_TOKEN');
  var customerId = '9441040274';  // US - Roland DG (no dashes)
  var mccId = '2505047359';       // Mediacom North MCC (no dashes)
  var query = "SELECT conversion_action.id, conversion_action.name FROM conversion_action WHERE conversion_action.status != 'REMOVED'";

  var url = 'https://googleads.googleapis.com/v25/customers/' + customerId + '/googleAds:search';
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: {
      Authorization: 'Bearer ' + service.getAccessToken(),
      'developer-token': devToken,
      'login-customer-id': mccId,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify({ query: query }),
    muteHttpExceptions: true
  });
  Logger.log('Code: ' + res.getResponseCode());
  Logger.log('Body: ' + res.getContentText());
}
