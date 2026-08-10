// Tests for the pure model: parsing, severity, formatting and error classification.

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    NodeLevel,
    parseCpuMilli,
    parseMemBytes,
    formatAge,
    parseHealth,
    parseNodesDetail,
    parseMetrics,
    applyMetrics,
    parsePods,
    nodeLevel,
    aggregateLevel,
    compareNodes,
    nodeQualifier,
    meterLevel,
    classifyError,
    safeNodeName,
} from '../lib/model.js';

import {NOW, HEALTH_TEXT, DETAIL_OBJ, METRICS_OBJ, PODS_TEXT} from './fixtures.js';

test('parseCpuMilli handles every unit suffix', () => {
    assert.equal(parseCpuMilli('500m'), 500);
    assert.equal(parseCpuMilli('4'), 4000);
    assert.equal(parseCpuMilli('2000000n'), 2);      // nanocores → millicores
    assert.equal(parseCpuMilli('3000u'), 3);         // microcores → millicores
    assert.equal(parseCpuMilli(''), null);
    assert.equal(parseCpuMilli(null), null);
});

test('parseMemBytes handles binary, decimal, and bare units', () => {
    assert.equal(parseMemBytes('1Ki'), 1024);
    assert.equal(parseMemBytes('1Mi'), 1024 ** 2);
    assert.equal(parseMemBytes('2Gi'), 2 * 1024 ** 3);
    assert.equal(parseMemBytes('1M'), 1e6);
    assert.equal(parseMemBytes('1024'), 1024);
    assert.equal(parseMemBytes('garbage'), null);
    assert.equal(parseMemBytes(''), null);
    // The unit group matches any letters, so an inherited Object member must not
    // be mistaken for a unit (a bare lookup would return a function -> NaN).
    assert.equal(parseMemBytes('5constructor'), 5);
    assert.equal(parseMemBytes('5toString'), 5);
    assert.equal(parseMemBytes('5valueOf'), 5);
});

test('formatAge buckets seconds/minutes/hours/days from a fixed now', () => {
    assert.equal(formatAge('2026-01-09T23:59:30Z', NOW), '30s');
    assert.equal(formatAge('2026-01-09T23:15:00Z', NOW), '45m');
    assert.equal(formatAge('2026-01-09T22:00:00Z', NOW), '2h');
    assert.equal(formatAge('2025-12-11T00:00:00Z', NOW), '30d');
    assert.equal(formatAge('', NOW), '');
    assert.equal(formatAge('not-a-date', NOW), '');
});

test('nodeLevel: not-ready is error, pressure/cordon is warning, else ok', () => {
    assert.equal(nodeLevel({ready: false, issues: [], unschedulable: false}), NodeLevel.ERROR);
    assert.equal(nodeLevel({ready: true, issues: ['MemoryPressure'], unschedulable: false}), NodeLevel.WARNING);
    assert.equal(nodeLevel({ready: true, issues: [], unschedulable: true}), NodeLevel.WARNING);
    assert.equal(nodeLevel({ready: true, issues: [], unschedulable: false}), NodeLevel.OK);
});

test('aggregateLevel is the worst node level present', () => {
    assert.equal(aggregateLevel([{level: 'ok'}, {level: 'warning'}, {level: 'ok'}]), NodeLevel.WARNING);
    assert.equal(aggregateLevel([{level: 'ok'}, {level: 'error'}, {level: 'warning'}]), NodeLevel.ERROR);
    assert.equal(aggregateLevel([{level: 'ok'}, {level: 'ok'}]), NodeLevel.OK);
});

test('parseHealth: every node branch + aggregates', () => {
    const {nodes, readyCount, total, level} = parseHealth(HEALTH_TEXT);
    const by = Object.fromEntries(nodes.map(n => [n.name, n]));

    assert.equal(total, 6);
    assert.equal(readyCount, 4);                    // ok, mem, cordon, net
    assert.equal(level, NodeLevel.ERROR);           // down + unknown

    assert.equal(by['node-ok'].level, NodeLevel.OK);
    assert.equal(by['node-ok'].statusText, 'Ready');

    assert.deepEqual(by['node-mem'].issues, ['MemoryPressure']);
    assert.equal(by['node-mem'].level, NodeLevel.WARNING);

    assert.equal(by['node-cordon'].unschedulable, true);
    assert.equal(by['node-cordon'].statusText, 'Ready,SchedulingDisabled');
    assert.equal(by['node-cordon'].level, NodeLevel.WARNING);

    assert.equal(by['node-down'].ready, false);
    assert.equal(by['node-down'].statusText, 'NotReady');
    assert.equal(by['node-down'].level, NodeLevel.ERROR);

    assert.equal(by['node-unknown'].ready, false);
    assert.equal(by['node-unknown'].statusText, 'Unknown');
    assert.equal(by['node-unknown'].level, NodeLevel.ERROR);

    assert.deepEqual(by['node-net'].issues, ['NetworkUnavailable']);
    assert.equal(by['node-net'].level, NodeLevel.WARNING);
});

test('parseNodesDetail: roles, ages, capacity, aggregates', () => {
    const {nodes, readyCount, total, level} = parseNodesDetail(JSON.stringify(DETAIL_OBJ), NOW);
    const by = Object.fromEntries(nodes.map(n => [n.name, n]));

    assert.equal(total, 3);
    assert.equal(readyCount, 2);
    assert.equal(level, NodeLevel.ERROR);

    assert.deepEqual(by['cp-1'].roles, ['control-plane']);
    assert.equal(by['cp-1'].level, NodeLevel.OK);
    assert.equal(by['cp-1'].since, '2h');
    assert.equal(by['cp-1'].age, '30d');
    assert.equal(by['cp-1'].version, 'v1.34.6+k3s1');
    assert.equal(by['cp-1'].cpuCapacityMilli, 4000);
    assert.equal(by['cp-1'].memCapacityBytes, 8148256 * 1024);

    assert.deepEqual(by['worker-1'].roles, ['worker']);   // no role label → default
    assert.deepEqual(by['worker-1'].issues, ['MemoryPressure']);
    assert.equal(by['worker-1'].level, NodeLevel.WARNING);
    assert.equal(by['worker-1'].since, '3d');

    assert.equal(by['worker-2'].ready, false);
    assert.equal(by['worker-2'].unschedulable, true);
    assert.equal(by['worker-2'].statusText, 'NotReady,SchedulingDisabled');
    assert.equal(by['worker-2'].level, NodeLevel.ERROR);
    assert.equal(by['worker-2'].since, '45m');
});

test('parseMetrics + applyMetrics compute CPU%/MEM% of capacity', () => {
    const detail = parseNodesDetail(JSON.stringify(DETAIL_OBJ), NOW);
    const metrics = parseMetrics(JSON.stringify(METRICS_OBJ));
    applyMetrics(detail.nodes, metrics);
    const by = Object.fromEntries(detail.nodes.map(n => [n.name, n]));

    assert.equal(by['cp-1'].cpuPct, 13);       // 500m / 4 cores
    assert.equal(by['cp-1'].memPct, 25);       // 2000000Ki / 8148256Ki
    assert.equal(by['worker-1'].cpuPct, 50);   // 4 / 8 cores
    assert.equal(by['worker-1'].memPct, 50);   // 8Gi / 16Gi
    assert.equal(by['worker-2'].cpuPct, null); // no metrics for this node
    assert.equal(by['worker-2'].memPct, null);
});

test('applyMetrics tolerates a null metrics map (metrics-server absent)', () => {
    const detail = parseNodesDetail(JSON.stringify(DETAIL_OBJ), NOW);
    applyMetrics(detail.nodes, null);
    for (const n of detail.nodes) {
        assert.equal(n.cpuPct, null);
        assert.equal(n.memPct, null);
    }
});

test('parsePods aggregates phases and crashloop', () => {
    const s = parsePods(PODS_TEXT);
    assert.deepEqual(s, {total: 6, running: 3, pending: 1, failed: 1, succeeded: 1, crashloop: 1});
});

test('compareNodes orders most-severe first, then by name', () => {
    const nodes = [
        {name: 'b', level: NodeLevel.OK},
        {name: 'a', level: NodeLevel.ERROR},
        {name: 'c', level: NodeLevel.OK},
        {name: 'd', level: NodeLevel.WARNING},
    ];
    const order = [...nodes].sort(compareNodes).map(n => n.name);
    assert.deepEqual(order, ['a', 'd', 'b', 'c']);
});

test('nodeQualifier: role when healthy, reason when degraded, empty when down', () => {
    assert.equal(
        nodeQualifier({ready: true, level: NodeLevel.OK, roles: ['worker'], issues: []}),
        'worker');
    assert.equal(
        nodeQualifier({ready: true, level: NodeLevel.WARNING, roles: ['worker'], issues: ['MemoryPressure']}),
        'MemoryPressure');
    // A down node reports its raw status: the only text saying it is down, so
    // state is not carried by the red dot alone (WCAG 1.4.1).
    assert.equal(
        nodeQualifier({
            ready: false, level: NodeLevel.ERROR, roles: ['worker'], issues: [],
            statusText: 'NotReady',
        }),
        'NotReady');
    assert.equal(
        nodeQualifier({
            ready: false, level: NodeLevel.ERROR, roles: ['worker'], issues: [],
            statusText: 'NotReady,SchedulingDisabled',
        }),
        'NotReady,SchedulingDisabled');
    // Health-tier nodes without statusText degrade to empty rather than throwing.
    assert.equal(
        nodeQualifier({ready: false, level: NodeLevel.ERROR, roles: ['worker'], issues: []}),
        '');
});

test('meterLevel buckets load% into ok/warning/error at 70 and 90', () => {
    assert.equal(meterLevel(0), NodeLevel.OK);
    assert.equal(meterLevel(69), NodeLevel.OK);
    assert.equal(meterLevel(70), NodeLevel.WARNING);   // warning boundary
    assert.equal(meterLevel(89), NodeLevel.WARNING);
    assert.equal(meterLevel(90), NodeLevel.ERROR);     // error boundary
    assert.equal(meterLevel(100), NodeLevel.ERROR);
});

test('parsers survive objects missing metadata/status/spec entirely', () => {
    // Defensive ?? {} paths: a node object stripped to nothing must not throw.
    const bare = parseNodesDetail(JSON.stringify({items: [{}]}), NOW);
    assert.equal(bare.total, 1);
    assert.equal(bare.nodes[0].name, 'unknown');
    assert.deepEqual(bare.nodes[0].roles, ['worker']);   // synthesized fallback
    assert.equal(bare.nodes[0].ready, false);            // no Ready condition -> not ready
    assert.equal(bare.nodes[0].cpuCapacityMilli, null);
    assert.equal(bare.nodes[0].age, '');                 // no creationTimestamp

    // A payload with no items list at all.
    assert.equal(parseNodesDetail(JSON.stringify({}), NOW).total, 0);
    assert.equal(parseMetrics(JSON.stringify({})).size, 0);

    // Metrics entry with no metadata: keyed undefined rather than throwing.
    const m = parseMetrics(JSON.stringify({items: [{usage: {cpu: '1', memory: '1Ki'}}]}));
    assert.equal(m.size, 1);
});

test('classifyError tolerates empty, whitespace-only and nullish input', () => {
    assert.deepEqual(classifyError(null),
        {key: 'unknown', title: 'kubectl ran into a problem', detail: ''});
    assert.deepEqual(classifyError(undefined),
        {key: 'unknown', title: 'kubectl ran into a problem', detail: ''});
    assert.equal(classifyError('   \n  \n ').detail, '');   // every line blank -> no detail
    // Only klog lines: falls back to unwrapping the first one.
    const klogOnly = classifyError(
        'E0711 22:10:05.879293  658680 memcache.go:265] "Unhandled Error" err="boom"');
    assert.equal(klogOnly.detail, 'boom');
});

test('classifyError buckets each kubectl failure into a human headline', () => {
    const title = raw => classifyError(raw).title;

    // A chained message (deadline + trailing EOF) is a timeout, not a drop.
    assert.equal(
        title('error: client rate limiter Wait returned an error: context deadline exceeded - error from a previous attempt: EOF'),
        "The cluster didn't answer in time");
    assert.equal(title('Unable to connect to the server: dial tcp 10.0.0.1:6443: connect: connection refused'),
        "Can't reach the cluster");
    assert.equal(title('Get "https://api:6443/api": dial tcp: lookup api on 1.1.1.1:53: no such host'),
        "Can't reach the cluster");
    assert.equal(title('x509: certificate signed by unknown authority'),
        "The cluster's certificate can't be verified");
    assert.equal(title('error: You must be logged in to the server (Unauthorized)'),
        'The cluster rejected the login');
    assert.equal(title('nodes is forbidden: User "dev" cannot list resource "nodes" in API group ""'),
        "This login can't read the cluster");
    assert.equal(title('error: getting credentials: exec: executable kubectl-oidc_login failed'),
        'The login has expired');
    assert.equal(title('Failed to execute child process "kubectl" (No such file or directory)'),
        "Can't find kubectl");
    assert.equal(title('error: no configuration has been provided, try setting KUBECONFIG'),
        'No kubeconfig found');
    assert.equal(title('error: context "old" does not exist'),
        "The selected context doesn't exist");
    // kubectl 1.35's wording for a missing context.
    assert.equal(title('Error in configuration: context was not found for specified context: old'),
        "The selected context doesn't exist");
    assert.equal(title('error: something nobody has ever seen'),
        'kubectl ran into a problem');
});

test('classifyError: offline reattributes network failures to the local machine', () => {
    // The watchdog path carries no kubectl words at all.
    assert.deepEqual(classifyError('whatever', {timedOut: true, offline: true}),
        {key: 'offline', title: 'No internet connection', detail: ''});
    // Network-shaped kubectl failures follow.
    assert.equal(classifyError('dial tcp 10.0.0.1:6443: i/o timeout', {offline: true}).key,
        'offline');
    assert.equal(classifyError('dial tcp: lookup api: no such host', {offline: true}).key,
        'offline');
    // Local problems stay local: being offline does not excuse a bad setup.
    assert.equal(classifyError('error: no configuration has been provided', {offline: true}).key,
        'noConfig');
    assert.equal(classifyError('Failed to execute child process "kubectl"', {offline: true}).key,
        'kubectlMissing');
    // And without the flag nothing changes.
    assert.equal(classifyError('dial tcp: lookup api: no such host').key, 'unreachable');
    assert.equal(classifyError('whatever', {timedOut: true}).key, 'timeout');
});

test('classifyError strips klog noise from the detail, keeps kubectl words', () => {
    const raw = 'E0711 22:10:05.879293  658680 memcache.go:265] "Unhandled Error" ' +
        'err="couldn\'t get current server API group list: Get \\"http://localhost:8080/api?timeout=5s\\": ' +
        'dial tcp [::1]:8080: connect: connection refused"';
    const {title, detail} = classifyError(raw);
    assert.equal(title, "Can't reach the cluster");
    // klog prefix and the "Unhandled Error" err= wrapper gone, quotes unescaped.
    assert.equal(detail,
        'couldn\'t get current server API group list: Get "http://localhost:8080/api?timeout=5s": ' +
        'dial tcp [::1]:8080: connect: connection refused');
});

test('classifyError prefers kubectl\'s human summary over the repeated klog noise', () => {
    // kubectl 1.35 emits repeated klog lines then a plain summary; use the summary.
    const klog = 'E0713 13:30:03.888827   96402 memcache.go:265] "Unhandled Error" ' +
        'err="couldn\'t get current server API group list: dial tcp 127.0.0.1:8080: connect: connection refused"';
    const raw = `${klog}\n${klog}\n${klog}\n` +
        'The connection to the server 127.0.0.1:8080 was refused - did you specify the right host or port?';
    assert.deepEqual(classifyError(raw), {
        key: 'unreachable',
        title: "Can't reach the cluster",
        detail: 'The connection to the server 127.0.0.1:8080 was refused - did you specify the right host or port?',
    });
});

test('classifyError redacts credential material an exec plugin may have logged', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.c2lnbmF0dXJl';
    const detail = raw => classifyError(raw).detail;

    // OIDC / exec-plugin token echoed into stderr.
    const oidc = detail(`error: id_token ${jwt} was rejected by the server`);
    assert.ok(!oidc.includes(jwt), `token leaked: ${oidc}`);
    assert.ok(oidc.includes('[redacted'), oidc);

    // aws eks get-token style presigned URL.
    const presigned = detail(
        'Get "https://sts.amazonaws.com/?Action=GetCallerIdentity&X-Amz-Security-Token=FQoDYXdzEBYaD' +
        '&X-Amz-Signature=abc123": dial tcp: lookup sts.amazonaws.com: no such host');
    assert.ok(!presigned.includes('FQoDYXdzEBYaD'), presigned);
    assert.ok(!presigned.includes('abc123'), presigned);
    assert.ok(presigned.includes('no such host'), presigned);   // the useful part survives

    // Authorization header dump.
    assert.ok(!detail(`Unauthorized: Authorization: Bearer ${jwt}`).includes(jwt));
    // key=value prose.
    assert.ok(!detail('failed: token=s3cr3tvalue rejected').includes('s3cr3tvalue'));
    // Client certificate / key material.
    const pem = detail('-----BEGIN PRIVATE KEY-----\nMIIEvQIBADAN\n-----END PRIVATE KEY-----');
    assert.ok(!pem.includes('MIIEvQIBADAN'), pem);
});

test('safeNodeName neutralizes names that would be unsafe to key, render or paste', () => {
    assert.equal(safeNodeName('worker-1.example.com'), 'worker-1.example.com');   // valid: untouched
    // A newline would otherwise auto-execute the rest once pasted into a shell.
    assert.equal(safeNodeName('worker-1\nrm -rf /'), 'worker-1rm-rf');
    assert.equal(safeNodeName('a;b`c$(id)'), 'abcid');
    assert.equal(safeNodeName('  padded  '), 'padded');
    assert.equal(safeNodeName(''), 'unknown');
    assert.equal(safeNodeName(null), 'unknown');
    assert.equal(safeNodeName('!!!'), 'unknown');            // nothing salvageable
    assert.equal(safeNodeName('x'.repeat(400)).length, 253);  // capped at the RFC 1123 limit
});

test('parseHealth and parseNodesDetail run node names through safeNodeName', () => {
    // parseHealth is line-based, so the interesting case here is shell metacharacters.
    const health = parseHealth('evil;rm -rf /\tfalse\tReady=True,\n');
    assert.equal(health.nodes[0].name, 'evilrm-rf');
    const detail = parseNodesDetail(JSON.stringify({
        items: [{metadata: {name: 'evil;rm -rf /', creationTimestamp: '2026-01-01T00:00:00Z'}, status: {}, spec: {}}],
    }), NOW);
    assert.equal(detail.nodes[0].name, 'evilrm-rf');
});

test('classifyError caps the detail length and honours the watchdog flag', () => {
    assert.equal(classifyError('x'.repeat(500)).detail.length, 200);   // 199 + ellipsis
    // The watchdog killed the poll: timeout headline, no misleading detail.
    assert.deepEqual(classifyError('Operation was cancelled', {timedOut: true}),
        {key: 'timeout', title: "The cluster didn't answer in time", detail: ''});
});
