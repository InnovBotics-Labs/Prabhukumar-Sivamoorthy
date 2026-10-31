/* ============================================================
   Lattice — conversion engine (ported from the prototype's convert.js)
   Parsers (text -> JS model) and Serializers (JS model -> text) for
   JSON, YAML, XML, CSV, TSV, TOML. The CDN globals are replaced with
   bundled npm imports, so every format is always available.
   ============================================================ */
import * as yaml from "js-yaml"; // namespace import: js-yaml 5 has no default export
import Papa from "papaparse";
import { parse as tomlParse, stringify as tomlStringify } from "smol-toml";

// ---- friendly conversion error (optional .loc = {line, column, pos}) ----
export function ConvError(msg, loc) {
  this.message = msg;
  this.name = "ConvError";
  if (loc) this.loc = loc;
}
ConvError.prototype = Object.create(Error.prototype);

function locFromPos(text, pos) {
  if (pos == null || pos < 0) return null;
  var upto = text.slice(0, pos);
  var nl = upto.lastIndexOf("\n");
  return { line: upto.split("\n").length, column: pos - nl, pos: pos };
}

export function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
export function typeOf(v) {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  var t = typeof v;
  if (t === "object") return "object";
  if (t === "number") return Number.isFinite(v) ? "number" : "string";
  if (t === "boolean") return "boolean";
  return "string";
}

// Libraries are bundled, so every format is always available.
export var FORMAT_LIB = { json: null, xml: null, yaml: "yaml", csv: "papa", tsv: "papa", toml: "toml" };
export var LIB_NAME = { yaml: "js-yaml", papa: "PapaParse", toml: "smol-toml" };
export function formatAvailable() { return true; }
export function libReady() { return true; }

/* ===================== XML ===================== */
function xmlParse(text) {
  var doc = new DOMParser().parseFromString(text, "application/xml");
  var perr = doc.querySelector("parsererror");
  if (perr) {
    var raw = perr.textContent.replace(/\s+/g, " ").trim();
    var loc = null;
    var m = raw.match(/line[^\d]*(\d+)[^\d]+column[^\d]*(\d+)/i);
    if (m) loc = { line: +m[1], column: +m[2] };
    var msg = raw.replace(/^This page contains the following errors:\s*/i, "").trim();
    throw new ConvError(msg || "Malformed XML.", loc);
  }
  var root = doc.documentElement;
  if (!root) throw new ConvError("No root element found.");
  var out = {};
  out[root.nodeName] = elementToObj(root);
  return out;
}
function elementToObj(el) {
  var obj = {};
  var i;
  for (i = 0; i < el.attributes.length; i++) obj["@" + el.attributes[i].name] = el.attributes[i].value;
  var childEls = [];
  var text = "";
  for (i = 0; i < el.childNodes.length; i++) {
    var n = el.childNodes[i];
    if (n.nodeType === 1) childEls.push(n);
    else if (n.nodeType === 3 || n.nodeType === 4) text += n.nodeValue;
  }
  text = text.trim();
  if (childEls.length === 0) {
    if (Object.keys(obj).length === 0) return text;
    if (text !== "") obj["#text"] = text;
    return obj;
  }
  var groups = {};
  for (i = 0; i < childEls.length; i++) {
    var c = childEls[i];
    var name = c.nodeName;
    var val = elementToObj(c);
    if (Object.prototype.hasOwnProperty.call(groups, name)) {
      if (!Array.isArray(groups[name])) groups[name] = [groups[name]];
      groups[name].push(val);
    } else groups[name] = val;
  }
  Object.keys(groups).forEach(function (k) { obj[k] = groups[k]; });
  if (text !== "") obj["#text"] = text;
  return obj;
}
function escText(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function escAttr(s) { return escText(s).replace(/"/g, "&quot;"); }
function buildNodes(name, value, depth) {
  if (Array.isArray(value)) return value.map(function (item) { return buildNodes(name, item, depth); }).join("\n");
  var pad = "  ".repeat(depth);
  if (isPlainObject(value)) {
    var attrs = [], children = [], text = null;
    Object.keys(value).forEach(function (k) {
      if (k.charAt(0) === "@") attrs.push(" " + k.slice(1) + '="' + escAttr(String(value[k])) + '"');
      else if (k === "#text") text = value[k];
      else children.push(buildNodes(k, value[k], depth + 1));
    });
    var a = attrs.join("");
    if (children.length === 0 && text === null) return pad + "<" + name + a + "/>";
    if (children.length === 0) return pad + "<" + name + a + ">" + escText(String(text)) + "</" + name + ">";
    var inner = children.join("\n");
    if (text !== null) inner = pad + "  " + escText(String(text)) + "\n" + inner;
    return pad + "<" + name + a + ">\n" + inner + "\n" + pad + "</" + name + ">";
  }
  if (value === null || value === undefined) return pad + "<" + name + "/>";
  return pad + "<" + name + ">" + escText(String(value)) + "</" + name + ">";
}
function xmlBuild(value) {
  var header = '<?xml version="1.0" encoding="UTF-8"?>';
  if (Array.isArray(value)) {
    var items = value.map(function (it) { return buildNodes("item", it, 1); }).join("\n");
    return header + "\n<root>\n" + items + "\n</root>";
  }
  if (isPlainObject(value)) {
    var keys = Object.keys(value);
    if (keys.length === 1 && !Array.isArray(value[keys[0]])) return header + "\n" + buildNodes(keys[0], value[keys[0]], 0);
    return header + "\n" + buildNodes("root", value, 0);
  }
  return header + "\n" + buildNodes("root", value, 0);
}

/* ===================== CSV / TSV ===================== */
function flatten(value) {
  var out = {};
  (function rec(v, prefix) {
    if (isPlainObject(v)) {
      var keys = Object.keys(v);
      if (keys.length === 0) { out[prefix || "value"] = ""; return; }
      keys.forEach(function (k) { rec(v[k], prefix ? prefix + "." + k : k); });
    } else if (Array.isArray(v)) {
      if (v.length === 0) { out[prefix || "value"] = ""; return; }
      v.forEach(function (item, i) { rec(item, prefix ? prefix + "." + i : String(i)); });
    } else {
      out[prefix === "" ? "value" : prefix] = v;
    }
  })(value, "");
  return out;
}
function dsvBuild(value, delim) {
  var rows = Array.isArray(value) ? value : [value];
  var flatRows = rows.map(flatten);
  var headers = [], seen = {};
  flatRows.forEach(function (fr) {
    Object.keys(fr).forEach(function (k) { if (!seen[k]) { seen[k] = 1; headers.push(k); } });
  });
  var data = flatRows.map(function (fr) { return headers.map(function (h) { return fr[h] === undefined ? "" : fr[h]; }); });
  return Papa.unparse({ fields: headers, data: data }, { delimiter: delim });
}
function autoType(s) {
  if (typeof s !== "string") return s;
  var t = s.trim();
  if (t === "") return "";
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) {
    var n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  return s;
}
function setDeep(root, dotted, val) {
  var parts = dotted.split(".");
  var cur = root;
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    var last = i === parts.length - 1;
    var isIdx = /^\d+$/.test(p);
    var key = isIdx ? Number(p) : p;
    if (last) { cur[key] = val; continue; }
    var nextIdx = /^\d+$/.test(parts[i + 1]);
    if (cur[key] === undefined || cur[key] === null || typeof cur[key] !== "object") cur[key] = nextIdx ? [] : {};
    cur = cur[key];
  }
}
function dsvParse(text, delim) {
  var res = Papa.parse(text.replace(/\s+$/, ""), { delimiter: delim, header: true, skipEmptyLines: true });
  if (res.errors && res.errors.length) {
    var e = res.errors[0];
    var line = e.row != null ? e.row + 2 : null;
    throw new ConvError(e.message, line ? { line: line, column: 1 } : null);
  }
  return res.data.map(function (row) {
    var obj = {};
    Object.keys(row).forEach(function (h) { if (h === "" || h == null) return; setDeep(obj, h, autoType(row[h])); });
    return obj;
  });
}

/* ===================== JSON locator ===================== */
function jsonLocate(s) {
  var i = 0, n = s.length, error = null;
  function ws() { while (i < n) { var c = s[i]; if (c === " " || c === "\t" || c === "\n" || c === "\r") i++; else break; } }
  function err(msg) { return { pos: Math.min(i, n), message: msg }; }
  function value() {
    ws();
    if (i >= n) { error = err("Unexpected end of input"); return false; }
    var c = s[i];
    if (c === "{") return object();
    if (c === "[") return array();
    if (c === '"') return string();
    if (c === "-" || (c >= "0" && c <= "9")) return number();
    if (s.substr(i, 4) === "true") { i += 4; return true; }
    if (s.substr(i, 5) === "false") { i += 5; return true; }
    if (s.substr(i, 4) === "null") { i += 4; return true; }
    error = err("Unexpected token " + JSON.stringify(c));
    return false;
  }
  function string() {
    i++;
    while (i < n) {
      var c = s[i++];
      if (c === "\\") { if (i >= n) break; i++; continue; }
      if (c === '"') return true;
      if (c === "\n") { i--; error = err("Unterminated string"); return false; }
    }
    error = err("Unterminated string");
    return false;
  }
  function number() {
    var m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(s.slice(i));
    if (!m || !m[0]) { error = err("Invalid number"); return false; }
    i += m[0].length;
    return true;
  }
  function object() {
    i++; ws();
    if (s[i] === "}") { i++; return true; }
    while (true) {
      ws();
      if (s[i] !== '"') { error = err("Expected a property name in double quotes"); return false; }
      if (!string()) return false;
      ws();
      if (s[i] !== ":") { error = err("Expected ':' after property name"); return false; }
      i++;
      if (!value()) return false;
      ws();
      if (s[i] === ",") { i++; continue; }
      if (s[i] === "}") { i++; return true; }
      error = err("Expected ',' or '}' here — a comma may be missing above");
      return false;
    }
  }
  function array() {
    i++; ws();
    if (s[i] === "]") { i++; return true; }
    while (true) {
      if (!value()) return false;
      ws();
      if (s[i] === ",") { i++; continue; }
      if (s[i] === "]") { i++; return true; }
      error = err("Expected ',' or ']' here — a comma may be missing above");
      return false;
    }
  }
  if (!value()) return error;
  ws();
  if (i < n) return err("Unexpected trailing content");
  return null;
}

/* ===================== registry ===================== */
var Parsers = {
  json: function (t) {
    try { return JSON.parse(t); }
    catch (e) {
      var raw = e.message || "Invalid JSON";
      var loc = null, msg = raw;
      var found = jsonLocate(t);
      if (found) { loc = locFromPos(t, found.pos); msg = found.message; }
      else {
        var mLC = raw.match(/line (\d+) column (\d+)/i);
        var mPos = raw.match(/position (\d+)/i);
        if (mLC) loc = { line: +mLC[1], column: +mLC[2] };
        else if (mPos) loc = locFromPos(t, +mPos[1]);
        msg = raw.replace(/\s*in JSON at position[\s\S]*$/i, "").trim() || raw;
      }
      throw new ConvError(msg, loc);
    }
  },
  yaml: function (t) {
    try { return yaml.load(t); }
    catch (e) {
      var loc = e.mark ? { line: (e.mark.line || 0) + 1, column: (e.mark.column || 0) + 1, pos: e.mark.position } : null;
      throw new ConvError(e.reason || e.message || "Invalid YAML", loc);
    }
  },
  toml: function (t) {
    try { return tomlParse(t); }
    catch (e) {
      var loc = null;
      if (typeof e.line === "number") loc = { line: e.line, column: typeof e.column === "number" ? e.column : e.col || 1 };
      else { var m = (e.message || "").match(/line\s+(\d+)[^\d]*(?:column|col)\s+(\d+)/i); if (m) loc = { line: +m[1], column: +m[2] }; }
      throw new ConvError(e.message || "Invalid TOML", loc);
    }
  },
  xml: function (t) { return xmlParse(t); },
  csv: function (t) { return dsvParse(t, ","); },
  tsv: function (t) { return dsvParse(t, "\t"); },
};

var Serializers = {
  json: function (v) { return JSON.stringify(v, null, 2); },
  yaml: function (v) { return yaml.dump(v, { indent: 2, lineWidth: -1, noRefs: true }).replace(/\n$/, ""); },
  toml: function (v) {
    if (!isPlainObject(v)) {
      throw new ConvError(
        "TOML needs an object (table) at the top level.\nYour data is " +
          (Array.isArray(v) ? "an array" : "a " + typeOf(v)) +
          ' — wrap it in a key, e.g. { "items": [...] }, then convert.',
      );
    }
    return tomlStringify(v);
  },
  xml: function (v) { return xmlBuild(v); },
  csv: function (v) { return dsvBuild(v, ","); },
  tsv: function (v) { return dsvBuild(v, "\t"); },
};

export function parse(format, text) { return Parsers[format](text); }
export function serialize(format, value) { return Serializers[format](value); }
