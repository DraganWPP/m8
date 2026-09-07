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