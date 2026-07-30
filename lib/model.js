// Pure data model for Kubernetes node/pod status.
//
// This module has NO gi:// imports on purpose: everything here is plain data
// in → plain data out, so it runs unchanged under gnome-shell, plain gjs, and
// node (see tests/). All time-dependent functions take an explicit `nowMs` so
// they stay deterministic under test. The impure edges live in client.js
// (kubectl/Gio) and indicator.js (St/Clutter).

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

// Kubernetes node names are RFC 1123 DNS subdomains: lowercase alphanumerics,
// '-' and '.', at most 253 characters. We sanitize rather than trust, once, here
// at the parse boundary, because the name goes on to become a GSettings key, a
// Map key, St label text, and -- most sharply -- part of a shell command placed
// on the clipboard. A hostile or MITM'd API server returning a name with a
// newline in it would otherwise auto-execute the rest on paste, and an
// absurdly long name would bloat the persisted alert state.
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

// ---------------------------------------------------------------------------
// Kubernetes quantity parsers: CPU → millicores, memory → bytes.
// ---------------------------------------------------------------------------

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
    // "5constructor" or "5toString" would otherwise resolve up the prototype
    // chain to an inherited function, skip the `?? 1` default, and yield NaN.
    const unit = Object.hasOwn(MEM_UNITS, m[2]) ? MEM_UNITS[m[2]] : 1;
    return parseFloat(m[1]) * unit;
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
    const seconds = Math.max(0, (nowMs - t) / 1000);
    if (seconds < 60)
        return `${Math.floor(seconds)}s`;
    if (seconds < 3600)
        return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400)
        return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
}

// ---------------------------------------------------------------------------
// Severity: shared by both tiers so the panel dot means the same thing
// whether it came from a cheap health poll or a full detail poll.
// ---------------------------------------------------------------------------

/**
 * A node is ERROR when it is not Ready (NotReady or Unknown/unreachable),
 * WARNING when Ready-but-troubled (resource pressure, cordoned, or its network
 * is down), and OK otherwise.
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
 * Given a condition map {Ready:'True', MemoryPressure:'False', ...}, derive the
 * fields both tiers share: ready flag, human status text, and the issue list.
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

// ---------------------------------------------------------------------------
// Tier 1: compact health. Parses the tiny tab/comma line format emitted by
// client.js's health jsonpath (see NODES_HEALTH_JSONPATH). One line per node:
//   "<name>\t<unschedulable>\t<Type>=<Status>,<Type>=<Status>,...\n"
// This is all the panel dot and node-up/down notifications need.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tier 2: full detail from `kubectl get nodes -o json` (only fetched while the
// menu is open). Adds roles, ages, kubelet version and capacity on top of the
// shared status fields.
// ---------------------------------------------------------------------------

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
        // How long the node has held its current Ready state, i.e. how long it
        // has been alive (Ready=True) or dead (Ready=False/Unknown).
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

// ---------------------------------------------------------------------------
// Metrics (metrics-server) and pods: both menu-only.
// ---------------------------------------------------------------------------

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
 * returns `nodes` (they're freshly parsed each poll, so mutation is safe).
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

// ---------------------------------------------------------------------------
// Display helpers (pure): used by indicator.js, kept here so they're tested.
// ---------------------------------------------------------------------------

/**
 * Colour bucket for a CPU/MEM meter fill from a load percentage: OK below 70%,
 * WARNING from 70%, ERROR from 90%. Kept pure (not inline in the view) so the
 * thresholds are unit-tested.
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
 * The qualifier shown beside a node's up/down time: its role(s) when healthy,
 * the failure reason when degraded, and the raw status ("NotReady", "Unknown")
 * when it is down.
 *
 * That last case matters for more than tidiness: it is the only *text* that says
 * a node is down. Without it the row is a red dot plus a "↓ 3m" duration, i.e.
 * state carried by colour alone -- unreadable to a screen reader and ambiguous
 * for anyone who can't separate the dot hues (WCAG 1.4.1).
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

// ---------------------------------------------------------------------------
// Error classification: turn kubectl's raw stderr into a short human headline
// plus a de-noised detail line. Pure, so the wording and the matching both
// carry unit tests; the view (indicator.js) only renders {title, detail}.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ClassifiedError
 * @property {string} title   Short human headline (our wording).
 * @property {string} detail  kubectl's own words, de-noised; '' when none useful.
 */

// Human headline per category. Kept beside the classifier (not in the view) so
// the wording travels with the matching logic and its tests.
const ERROR_TITLE = {
    timeout: "The cluster didn't answer in time",
    tls: "The cluster's certificate didn't check out",
    unauthorized: 'The cluster turned down the login',
    login: 'The login needs renewing',
    forbidden: "This login can't read the cluster",
    kubectlMissing: "Can't find kubectl",
    unreachable: "Can't reach the cluster",
    noConfig: 'No kubeconfig found',
    badContext: "That context isn't set up",
    unknown: 'kubectl ran into a problem',
};

// Leading klog line client-go writes to stderr, e.g.
// `E0711 22:10:05.879293  658680 memcache.go:265] `. Dropped from the detail.
const KLOG_PREFIX = /^[EWIF]\d{4}\s[\d:.]+\s+\d+\s+\S+]\s*/;

// Credential shapes that can appear in kubectl stderr and must never be shown.
// client-go wires an exec credential plugin's stderr straight into kubectl's, so
// a failing `aws eks get-token` / OIDC helper can print presigned URLs carrying
// X-Amz-Security-Token, or token-endpoint error bodies containing JWTs. The
// detail is user-facing (menu, and previously notification bodies, which GNOME
// shows on the lock screen), so redact before anything can render it.
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
 * One clean line from kubectl's raw stderr. kubectl logs the same klog retry
 * warning several times and then prints a human summary as the final line
 * ("The connection to the server … was refused …"), so prefer the last
 * non-klog line; fall back to unwrapping a klog `err="…"` payload when that is
 * all there is. Then drop the leading `error:`, unescape quotes, collapse
 * whitespace, and cap the length. kubectl's words, de-noised; nothing invented.
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
    // Redact before truncating, so a cut can't leave a partial-but-still-secret
    // fragment (and can't split a token out of reach of the patterns).
    s = redactSecrets(s);
    return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

/**
 * Map a raw kubectl failure to a short human headline plus a de-noised detail.
 * Matching is ordered most-specific first: a message that chains several causes
 * (kubectl joins them with " - ") is classified by the most actionable one, so
 * a deadline that also reports a trailing EOF reads as a timeout, not a drop.
 * @param {unknown} raw   The thrown Error's message (or the value itself).
 * @param {{timedOut?: boolean}} [flags]  Set when our own watchdog killed the poll.
 * @returns {ClassifiedError}
 */
export function classifyError(raw, {timedOut = false} = {}) {
    // Our watchdog cancelled the poll: the raw value is a cancellation, not
    // kubectl's reason, so there is no honest detail to show.
    if (timedOut)
        return {title: ERROR_TITLE.timeout, detail: ''};

    const detail = cleanErrorDetail(raw);
    const m = String(raw ?? '').toLowerCase();
    /** @param {string[]} needles */
    const has = needles => needles.some(n => m.includes(n));

    /** @type {keyof typeof ERROR_TITLE} */
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

    return {title: ERROR_TITLE[key], detail};
}
