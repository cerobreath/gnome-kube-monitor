// Unit tests for the pure model. Run with `npm test` (node --test) — no deps,
// no network, no gnome-shell required.

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
    firstLine,
    diffReadiness,
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

test('firstLine trims to the first line and caps length', () => {
    assert.equal(firstLine('boom\nstack\nmore'), 'boom');
    assert.equal(firstLine('x'.repeat(500)).length, 240);
    assert.equal(firstLine(null), '');
});

test('diffReadiness reports down/up transitions (the notify logic)', () => {
    const prev = new Map([['a', true], ['b', true], ['c', false]]);
    const cur = new Map([['a', true], ['b', false], ['c', true], ['d', true]]);
    // b went down, c recovered, a unchanged, d is new (no baseline → ignored)
    assert.deepEqual(diffReadiness(prev, cur), {down: ['b'], up: ['c']});
});

test('diffReadiness yields nothing on the first poll (null baseline)', () => {
    // This is why already-down nodes at startup never notify — they only set the baseline.
    assert.deepEqual(diffReadiness(null, new Map([['a', false], ['b', true]])), {down: [], up: []});
});
