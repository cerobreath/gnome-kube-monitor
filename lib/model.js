// Pure data model for Kubernetes node/pod status: plain data in, plain data out.
// Must stay gi-free so it runs under gnome-shell, plain gjs and node alike, and
// time-dependent functions must take an explicit nowMs. Kubernetes' own
// vocabulary (Ready, NotReady, role names) is an API identifier: never translate.

import {_, N_, pgettext, format} from './i18n.js';

/** @typedef {'ok' | 'warning' | 'error' | 'unknown'} NodeLevelValue */

/**
 * @typedef {object} PodsSummary
 * @property {number} total
 * @property {number} running
 * @property {number} pending
 * @property {number} failed
 * @property {number} succeeded
 * @property {number} crashloop
 */

/**
 * @typedef {object} HealthNode
 * @property {string} name
 * @property {boolean} ready
 * @property {boolean} unschedulable
 * @property {string[]} issues
 * @property {string} statusText
 * @property {NodeLevelValue} level
 */

/**
 * @typedef {object} DetailNode
 * @property {string} name
 * @property {string[]} roles
 * @property {boolean} ready
 * @property {string} statusText
 * @property {string[]} issues
 * @property {boolean} unschedulable
 * @property {NodeLevelValue} level
 * @property {string} since  Age of the current Ready state ("3d", "45m", …).
 * @property {string} age    Age of the node itself.
 * @property {string} version
 * @property {number | null} cpuCapacityMilli
 * @property {number | null} memCapacityBytes
 * @property {number | null} cpuPct
 * @property {number | null} memPct
 */

/**
 * @typedef {object} MetricsEntry
 * @property {number | null} cpuMilli
 * @property {number | null} memBytes
 */

/**
 * @template T
 * @typedef {{nodes: T[], readyCount: number, total: number, level: NodeLevelValue}} NodeSummary
 */

export const NodeLevel = /** @type {{OK: 'ok', WARNING: 'warning', ERROR: 'error', UNKNOWN: 'unknown'}} */ ({
    OK: 'ok',
    WARNING: 'warning',
    ERROR: 'error',
    UNKNOWN: 'unknown',
});

// Most-severe first, so problem nodes surface at the top of the list.
export const LEVEL_RANK = /** @type {Record<NodeLevelValue, number>} */ ({
    [NodeLevel.ERROR]: 0,
    [NodeLevel.WARNING]: 1,
    [NodeLevel.UNKNOWN]: 2,
    [NodeLevel.OK]: 3,
});

const ROLE_PREFIX = 'node-role.kubernetes.io/';
const PRESSURE_TYPES = ['MemoryPressure', 'DiskPressure', 'PIDPressure'];

// Node names reach the clipboard as part of a shell command, so they are
// sanitized once here at the parse boundary. RFC 1123 allows only lowercase
// alphanumerics, '-' and '.', up to 253 characters.
const NODE_NAME_MAX = 253;
const NODE_NAME_SHAPE = /^[a-zA-Z0-9]([-a-zA-Z0-9.]*[a-zA-Z0-9])?$/;

/**
 * @param {unknown} raw
 * @returns {string} a name safe to key, render, and paste
 */
export function safeNodeName(raw) {
    const trimmed = String(raw ?? '').trim().slice(0, NODE_NAME_MAX);
    if (!trimmed)
        return 'unknown';
    if (NODE_NAME_SHAPE.test(trimmed))
        return trimmed;
    const scrubbed = trimmed.replace(/[^a-zA-Z0-9.\-_]/g, '');
    return scrubbed || 'unknown';
}

// Kubernetes quantity parsers: CPU → millicores, memory → bytes.

/**
 * @param {string | null | undefined} v
 * @returns {number | null}
 */
export function parseCpuMilli(v) {
    if (!v)
        return null;
    if (v.endsWith('n'))
        return parseFloat(v) / 1e6;
    if (v.endsWith('u'))
        return parseFloat(v) / 1e3;
    if (v.endsWith('m'))
        return parseFloat(v);
    return parseFloat(v) * 1000;
}

const MEM_UNITS = /** @type {Record<string, number>} */ ({
    '': 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15,
    Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5,
});

/**
 * @param {string | number | null | undefined} v
 * @returns {number | null}
 */
export function parseMemBytes(v) {
    if (!v)
        return null;
    const m = String(v).match(/^(\d+(?:\.\d+)?)\s*([A-Za-z]*)$/);
    if (!m)
        return null;
    // Object.hasOwn, not a bare lookup: the unit group matches any letters, so
    // "5toString" would otherwise resolve up the prototype chain and yield NaN.
    const unit = Object.hasOwn(MEM_UNITS, m[2]) ? MEM_UNITS[m[2]] : 1;
    return parseFloat(m[1]) * unit;
}

/**
 * Coarse "3d" / "5h" / "2m" / "10s" duration, in the shortest form the locale
 * has. Shared by every duration shown, so translators write each unit once.
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
    if (seconds < 60) {
        // Translators: abbreviated duration in seconds, e.g. "45s". %d is the
        // number of seconds. Keep it short: it shares a menu row with the node name.
        return format(pgettext('duration', '%ds'), Math.floor(seconds));
    }
    if (seconds < 3600) {
        // Translators: abbreviated duration in minutes, e.g. "45m". %d is the
        // number of minutes.
        return format(pgettext('duration', '%dm'), Math.floor(seconds / 60));
    }
    if (seconds < 86400) {
        // Translators: abbreviated duration in hours, e.g. "5h". %d is the
        // number of hours.
        return format(pgettext('duration', '%dh'), Math.floor(seconds / 3600));
    }
    // Translators: abbreviated duration in days, e.g. "3d". %d is the number
    // of days.
    return format(pgettext('duration', '%dd'), Math.floor(seconds / 86400));
}

/**
 * Coarse "3d" / "5h" / "2m" / "10s" age from an ISO-8601 timestamp.
 * @param {string | null | undefined} iso
 * @param {number} [nowMs]
 * @returns {string}
 */
export function formatAge(iso, nowMs = Date.now()) {
    if (!iso)
        return '';
    const t = Date.parse(iso);
    if (Number.isNaN(t))
        return '';
    return formatDuration(Math.max(0, (nowMs - t) / 1000));
}

// Severity: shared by both tiers so the panel dot means the same thing either way.

/**
 * ERROR when not Ready, WARNING when Ready but troubled (pressure, cordoned,
 * network down), OK otherwise.
 * @param {{ready: boolean, issues?: string[], unschedulable?: boolean}} node
 * @returns {NodeLevelValue}
 */
export function nodeLevel({ready, issues, unschedulable}) {
    if (!ready)
        return NodeLevel.ERROR;
    if ((issues && issues.length > 0) || unschedulable)
        return NodeLevel.WARNING;
    return NodeLevel.OK;
}

/**
 * Cluster level = the worst node level present.
 * @param {{level: NodeLevelValue}[]} nodes
 * @returns {NodeLevelValue}
 */
export function aggregateLevel(nodes) {
    if (nodes.some(n => n.level === NodeLevel.ERROR))
        return NodeLevel.ERROR;
    if (nodes.some(n => n.level === NodeLevel.WARNING))
        return NodeLevel.WARNING;
    return NodeLevel.OK;
}

/**
 * Severity-first ordering (ties broken by name) for the node list.
 * @param {{name: string, level: NodeLevelValue}} a
 * @param {{name: string, level: NodeLevelValue}} b
 * @returns {number}
 */
export function compareNodes(a, b) {
    return (LEVEL_RANK[a.level] - LEVEL_RANK[b.level]) || a.name.localeCompare(b.name);
}

/**
 * @template {{ready: boolean, level: NodeLevelValue}} T
 * @param {T[]} nodes
 * @returns {NodeSummary<T>}
 */
function summarize(nodes) {
    return {
        nodes,
        readyCount: nodes.filter(n => n.ready).length,
        total: nodes.length,
        level: aggregateLevel(nodes),
    };
}

/**
 * Derive the fields both tiers share from a condition map {Ready:'True', ...}.
 * @param {Record<string, string>} conditions
 * @param {boolean} unschedulable
 * @returns {{ready: boolean, statusText: string, issues: string[]}}
 */
function deriveStatus(conditions, unschedulable) {
    const readyStatus = conditions.Ready;               // 'True' | 'False' | 'Unknown' | undefined
    const ready = readyStatus === 'True';

    let statusText;
    if (!readyStatus)
        statusText = 'Unknown';
    else if (ready)
        statusText = 'Ready';
    else if (readyStatus === 'Unknown')
        statusText = 'Unknown';
    else
        statusText = 'NotReady';
    if (unschedulable)
        statusText += ',SchedulingDisabled';

    const issues = PRESSURE_TYPES.filter(t => conditions[t] === 'True');
    if (conditions.NetworkUnavailable === 'True')
        issues.push('NetworkUnavailable');

    return {ready, statusText, issues};
}

// Tier 1: compact health, one line per node from client.js NODES_HEALTH_JSONPATH:
//   "<name>\t<unschedulable>\t<Type>=<Status>,<Type>=<Status>,...\n"

/**
 * @param {string} text
 * @returns {NodeSummary<HealthNode>}
 */
export function parseHealth(text) {
    /** @type {HealthNode[]} */
    const nodes = [];
    for (const line of text.split('\n')) {
        if (!line.trim())
            continue;
        const [name = 'unknown', unsched = '', condsRaw = ''] = line.split('\t');
        /** @type {Record<string, string>} */
        const conditions = {};
        for (const pair of condsRaw.split(',')) {
            if (!pair)
                continue;
            const eq = pair.indexOf('=');
            if (eq > 0)
                conditions[pair.slice(0, eq)] = pair.slice(eq + 1);
        }
        const unschedulable = unsched === 'true';
        const {ready, statusText, issues} = deriveStatus(conditions, unschedulable);
        nodes.push({
            name: safeNodeName(name),
            ready,
            unschedulable,
            issues,
            statusText,
            level: nodeLevel({ready, issues, unschedulable}),
        });
    }
    return summarize(nodes);
}

// Watch tier: one event per line from client.js NODES_WATCH_JSONPATH, fields
// split on "|" (the watch printer pads tabs into spaces), with the condition
// types and statuses as two space-joined lists in matching order.

/**
 * @typedef {{type: 'DELETED', name: string} |
 *           {type: 'ADDED' | 'MODIFIED', name: string, node: HealthNode}} WatchEvent
 */

/**
 * @param {string} line
 * @returns {WatchEvent | null} null for blank, BOOKMARK, ERROR or malformed lines
 */
export function parseWatchEvent(line) {
    if (!line.trim())
        return null;
    const [type = '', rawName = '', unsched = '', typesRaw = '', statusesRaw = ''] =
        line.split('|');
    if (type !== 'ADDED' && type !== 'MODIFIED' && type !== 'DELETED')
        return null;
    if (!rawName.trim())
        return null;
    const name = safeNodeName(rawName);
    if (type === 'DELETED')
        return {type, name};
    /** @type {Record<string, string>} */
    const conditions = {};
    const types = typesRaw.split(' ').filter(Boolean);
    const statuses = statusesRaw.split(' ').filter(Boolean);
    for (let i = 0; i < types.length; i++)
        conditions[types[i]] = statuses[i] ?? '';
    const unschedulable = unsched === 'true';
    const {ready, statusText, issues} = deriveStatus(conditions, unschedulable);
    return {
        type,
        name,
        node: {
            name,
            ready,
            unschedulable,
            issues,
            statusText,
            level: nodeLevel({ready, issues, unschedulable}),
        },
    };
}

/**
 * Fold one event into a name-keyed node map. Mutates and returns the map.
 * @param {Map<string, HealthNode>} map
 * @param {WatchEvent} event
 * @returns {Map<string, HealthNode>}
 */
export function applyWatchEvent(map, event) {
    if (event.type === 'DELETED')
        map.delete(event.name);
    else
        map.set(event.name, event.node);
    return map;
}

/**
 * Snapshot of the watch map in the shape a health poll returns, sorted by name
 * so churn in event order cannot reshuffle the menu.
 * @param {Map<string, HealthNode>} map
 * @returns {NodeSummary<HealthNode>}
 */
export function summarizeHealthMap(map) {
    // Names are map keys, so the comparator never sees an equal pair.
    const nodes = [...map.values()].sort((a, b) => a.name < b.name ? -1 : 1);
    return summarize(nodes);
}

// Reconcile rows from the server-printed table (kubectl get nodes --no-headers):
// NAME STATUS ROLES AGE VERSION, none of which can contain spaces. The table
// cannot see pressure conditions, so it cross-checks the watch, never feeds the dot.

/**
 * @typedef {{name: string, ready: boolean, unschedulable: boolean}} TableRow
 */

/**
 * @param {string} text
 * @returns {TableRow[]}
 */
export function parseNodesTable(text) {
    /** @type {TableRow[]} */
    const rows = [];
    for (const line of text.split('\n')) {
        const cells = line.trim().split(/\s+/);
        if (cells.length < 2)
            continue;
        const status = cells[1].split(',');
        rows.push({
            name: safeNodeName(cells[0]),
            ready: status.includes('Ready'),
            unschedulable: status.includes('SchedulingDisabled'),
        });
    }
    return rows;
}

/**
 * True when the watch map and a fresh table disagree on membership, readiness
 * or cordon state, which means the stream went stale and must be restarted.
 * @param {Map<string, HealthNode>} map
 * @param {TableRow[]} rows
 * @returns {boolean}
 */
export function reconcileDiffers(map, rows) {
    if (map.size !== rows.length)
        return true;
    return rows.some(r => {
        const n = map.get(r.name);
        return !n || n.ready !== r.ready || n.unschedulable !== r.unschedulable;
    });
}

// Tier 2: full detail from kubectl get nodes -o json, fetched only while the menu
// is open. Adds roles, ages, kubelet version and capacity.

/**
 * @param {any} item  A single Kubernetes node object (untyped JSON).
 * @param {number} nowMs
 * @returns {DetailNode}
 */
function parseNode(item, nowMs) {
    const meta = item.metadata ?? {};
    const status = item.status ?? {};
    const spec = item.spec ?? {};
    const conditionList = status.conditions ?? [];

    /** @type {Record<string, string>} */
    const conditions = {};
    let readyTransition;
    for (const c of conditionList) {
        conditions[c.type] = c.status;
        if (c.type === 'Ready')
            readyTransition = c.lastTransitionTime;
    }

    const labels = meta.labels ?? {};
    let roles = Object.keys(labels)
        .filter(k => k.startsWith(ROLE_PREFIX))
        .map(k => k.slice(ROLE_PREFIX.length))
        .filter(Boolean);
    if (roles.length === 0)
        roles = ['worker'];

    const unschedulable = spec.unschedulable === true;
    const {ready, statusText, issues} = deriveStatus(conditions, unschedulable);

    return {
        name: safeNodeName(meta.name),
        roles,
        ready,
        statusText,
        issues,
        unschedulable,
        level: nodeLevel({ready, issues, unschedulable}),
        // How long the node has been alive (Ready=True) or dead (Ready=False/Unknown).
        since: formatAge(readyTransition ?? meta.creationTimestamp, nowMs),
        age: formatAge(meta.creationTimestamp, nowMs),
        version: status.nodeInfo?.kubeletVersion ?? '',
        cpuCapacityMilli: parseCpuMilli(status.capacity?.cpu),
        memCapacityBytes: parseMemBytes(status.capacity?.memory),
        cpuPct: null,
        memPct: null,
    };
}

/**
 * @param {string} jsonText
 * @param {number} [nowMs]
 * @returns {NodeSummary<DetailNode>}
 */
export function parseNodesDetail(jsonText, nowMs = Date.now()) {
    const data = JSON.parse(jsonText);
    const items = data.items ?? [];
    return summarize(items.map((/** @type {any} */ item) => parseNode(item, nowMs)));
}

// Metrics (metrics-server) and pods: both menu-only.

/**
 * Raw /apis/metrics.k8s.io/v1beta1/nodes → Map(name -> {cpuMilli, memBytes}).
 * @param {string} jsonText
 * @returns {Map<string, MetricsEntry>}
 */
export function parseMetrics(jsonText) {
    const data = JSON.parse(jsonText);
    /** @type {Map<string, MetricsEntry>} */
    const map = new Map();
    for (const item of data.items ?? []) {
        map.set(item.metadata?.name, {
            cpuMilli: parseCpuMilli(item.usage?.cpu),
            memBytes: parseMemBytes(item.usage?.memory),
        });
    }
    return map;
}

/**
 * Fold live metrics into detail nodes as CPU%/MEM% of capacity. Mutates and
 * returns the nodes, which are freshly parsed each poll.
 * @param {DetailNode[]} nodes
 * @param {Map<string, MetricsEntry> | null | undefined} metrics
 * @returns {DetailNode[]}
 */
export function applyMetrics(nodes, metrics) {
    for (const node of nodes) {
        const m = metrics?.get(node.name);
        node.cpuPct = (m && m.cpuMilli != null && node.cpuCapacityMilli)
            ? Math.round(m.cpuMilli / node.cpuCapacityMilli * 100) : null;
        node.memPct = (m && m.memBytes != null && node.memCapacityBytes)
            ? Math.round(m.memBytes / node.memCapacityBytes * 100) : null;
    }
    return nodes;
}

/**
 * Compact per-pod "phase|waitingReason,waitingReason," lines (see
 * client.js PODS_JSONPATH) → aggregated counts.
 * @param {string} text
 * @returns {PodsSummary}
 */
export function parsePods(text) {
    const summary = {total: 0, running: 0, pending: 0, failed: 0, succeeded: 0, crashloop: 0};
    for (const line of text.split('\n')) {
        if (!line.trim())
            continue;
        summary.total++;
        const [phase, reasons = ''] = line.split('|');
        if (phase === 'Running')
            summary.running++;
        else if (phase === 'Pending')
            summary.pending++;
        else if (phase === 'Failed')
            summary.failed++;
        else if (phase === 'Succeeded')
            summary.succeeded++;
        if (reasons.split(',').includes('CrashLoopBackOff'))
            summary.crashloop++;
    }
    return summary;
}

/**
 * Colour bucket for a CPU/MEM meter fill: OK below 70%, WARNING from 70%,
 * ERROR from 90%.
 * @param {number} pct
 * @returns {'ok' | 'warning' | 'error'}
 */
export function meterLevel(pct) {
    if (pct >= 90)
        return NodeLevel.ERROR;
    if (pct >= 70)
        return NodeLevel.WARNING;
    return NodeLevel.OK;
}

/**
 * Qualifier beside a node's up/down time: role(s) when healthy, the failure reason
 * when degraded, the raw status when down (state not by colour alone, WCAG 1.4.1).
 * @param {{ready: boolean, level: NodeLevelValue, roles: string[], issues: string[], statusText?: string}} node
 * @returns {string}
 */
export function nodeQualifier(node) {
    if (node.level === NodeLevel.OK)
        return node.roles.join(', ');
    if (!node.ready)
        return node.statusText ?? '';
    return node.issues.join(', ');
}

// Error classification: kubectl's raw stderr into a {title, detail} the view renders.

/**
 * @typedef {object} ClassifiedError
 * @property {ErrorKey} key   Machine-readable category, for logging and for
 *   callers that branch on the cause rather than re-match the prose.
 * @property {string} title   Short human headline, translated.
 * @property {string} detail  kubectl's own words, de-noised; '' when none useful.
 *   Never translated: it is kubectl's output.
 */

/** @typedef {keyof typeof ERROR_TITLE} ErrorKey */

// Human headline per category, beside the classifier so wording and matching stay
// together. N_() rather than _(): the table is built at module load, before any
// locale is bound, so it stores English and errorTitle() translates at lookup.
const ERROR_TITLE = {
    // Translators: shown when the cluster did not respond before the timeout.
    timeout: N_("The cluster didn't answer in time"),
    // Translators: TLS/x509 certificate verification failed.
    tls: N_("The cluster's certificate can't be verified"),
    // Translators: the API server rejected the credentials (HTTP 401).
    unauthorized: N_('The cluster rejected the login'),
    // Translators: an expired token that a credential helper must refresh.
    login: N_('The login has expired'),
    // Translators: authenticated, but not permitted to list nodes (HTTP 403).
    forbidden: N_("This login can't read the cluster"),
    // Translators: the kubectl binary itself could not be found or executed.
    kubectlMissing: N_("Can't find kubectl"),
    // Translators: the network could not reach the API server at all.
    unreachable: N_("Can't reach the cluster"),
    // Translators: the machine itself is offline, so the failure is local.
    offline: N_('No internet connection'),
    // Translators: no kubeconfig file exists to read a cluster from.
    noConfig: N_('No kubeconfig found'),
    // Translators: the selected context is missing from the kubeconfig.
    badContext: N_("The selected context doesn't exist"),
    // Translators: catch-all when kubectl failed for none of the above reasons.
    unknown: N_('kubectl ran into a problem'),
};

/**
 * The translated headline for an error category.
 * @param {ErrorKey} key
 * @returns {string}
 */
export function errorTitle(key) {
    return _(ERROR_TITLE[key]);
}

// Leading klog line client-go writes to stderr, e.g.
// `E0711 22:10:05.879293  658680 memcache.go:265] `. Dropped from the detail.
const KLOG_PREFIX = /^[EWIF]\d{4}\s[\d:.]+\s+\d+\s+\S+]\s*/;

// Credential shapes that can appear in kubectl stderr and must never be rendered.
// client-go wires an exec credential plugin's stderr straight into kubectl's, so a
// failing aws eks get-token or OIDC helper can print presigned URLs and JWTs.
const REDACTIONS = [
    // JWT / OIDC id_token & access_token: three base64url segments.
    [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]+)?/g, '[redacted-token]'],
    // Query-string credentials, e.g. ?X-Amz-Security-Token=…&X-Amz-Signature=…
    [/([?&](?:[A-Za-z0-9_-]*(?:token|signature|credential|key|secret|password)[A-Za-z0-9_-]*)=)[^&\s"']+/gi,
        '$1[redacted]'],
    // key=value / key: value forms in prose.
    [/\b((?:bearer|authorization|id_token|access_token|refresh_token|api[_-]?key|secret|password|passwd|token)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
        '$1[redacted]'],
    // `Authorization: Bearer <blob>` header dumps.
    [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
    // PEM blocks (client certs / keys) collapsed onto one line.
    [/-----BEGIN[^-]*-----[\s\S]*?(?:-----END[^-]*-----)?/g, '[redacted-pem]'],
];

/**
 * Strip anything credential-shaped from a string. Exported for lib/log.js, which
 * applies it to every diagnostic line: the journal is readable and long-lived.
 * @param {string} s
 * @returns {string}
 */
export function redactForLog(s) {
    return redactSecrets(s);
}

/**
 * Strip anything credential-shaped from a one-line error detail.
 * @param {string} s
 * @returns {string}
 */
function redactSecrets(s) {
    let out = s;
    for (const [pattern, replacement] of REDACTIONS)
        out = out.replace(/** @type {RegExp} */ (pattern), /** @type {string} */ (replacement));
    return out;
}

/**
 * One clean line from kubectl's raw stderr: prefer the last non-klog line, which
 * is the human summary kubectl prints after its retry warnings, else unwrap a
 * klog err="…" payload. Then de-noise, redact and cap the length.
 * @param {unknown} raw
 * @returns {string}
 */
function cleanErrorDetail(raw) {
    const lines = String(raw ?? '').split('\n').map(l => l.trim()).filter(Boolean);
    const readable = lines.filter(l => !KLOG_PREFIX.test(l));
    let s = readable.length ? readable[readable.length - 1] : (lines[0] ?? '').replace(KLOG_PREFIX, '');
    const errAt = s.indexOf('err="');
    if (errAt !== -1)
        s = s.slice(errAt + 5).replace(/"\s*$/, '');
    s = s.replace(/^error:\s*/i, '').replace(/\\"/g, '"').replace(/\s+/g, ' ').trim();
    // Redact before truncating: a cut could otherwise split a token out of reach
    // of the patterns and leave a partial but still secret fragment.
    s = redactSecrets(s);
    return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

/**
 * Map a raw kubectl failure to a headline plus a de-noised detail. Matching runs
 * most-specific first, so a chained message reads as its most actionable cause.
 * @param {unknown} raw   The thrown Error's message (or the value itself).
 * @param {{timedOut?: boolean, offline?: boolean}} [flags]  timedOut: the poller's
 *   watchdog killed it. offline: the machine had no network route when it failed.
 * @returns {ClassifiedError}
 */
export function classifyError(raw, {timedOut = false, offline = false} = {}) {
    // The watchdog cancelled the poll, so the raw value is a cancellation rather
    // than kubectl's reason: no detail to show.
    if (timedOut) {
        const key = offline ? 'offline' : 'timeout';
        return {key, title: errorTitle(key), detail: ''};
    }

    const detail = cleanErrorDetail(raw);
    const m = String(raw ?? '').toLowerCase();
    /** @param {string[]} needles */
    const has = needles => needles.some(n => m.includes(n));

    /** @type {ErrorKey} */
    let key;
    if (has(['context deadline exceeded', 'deadline exceeded', 'timeout exceeded',
        'request timed out', 'i/o timeout', 'client.timeout']))
        key = 'timeout';
    else if (has(['x509', 'certificate signed by', 'certificate has expired',
        'certificate is valid for', 'tls: ']))
        key = 'tls';
    else if (has(['you must be logged in', 'unauthorized',
        'the server has asked for the client to provide credentials']))
        key = 'unauthorized';
    else if (has(['getting credentials', 'exec plugin', 'credential plugin',
        'unable to retrieve token', 'refresh token', 'kubelogin', 'oidc']))
        key = 'login';
    else if (has(['forbidden', 'cannot list resource', 'is forbidden']))
        key = 'forbidden';
    else if (has(['failed to execute child process', 'executable file not found']))
        key = 'kubectlMissing';
    else if (has(['connection refused', 'the connection to the server', 'unable to connect to the server',
        'no such host', 'server misbehaving', 'network is unreachable', 'no route to host',
        'connection reset', ' eof', 'broken pipe', 'dial tcp', 'dial udp']))
        key = 'unreachable';
    else if (has(['no configuration has been provided', 'error loading config']))
        key = 'noConfig';
    else if (has(['does not exist', 'no context exists', 'context was not found', 'current-context']) &&
        has(['context']))
        key = 'badContext';
    else
        key = 'unknown';

    // A network-shaped failure with no route out is the local network's fault,
    // not the cluster's. Local errors (kubectlMissing, noConfig, …) keep their name.
    if (offline && (key === 'timeout' || key === 'unreachable'))
        key = 'offline';

    return {key, title: errorTitle(key), detail};
}
