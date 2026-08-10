// Fixtures covering every branch the parsers can take. A fixed NOW keeps the
// age and since assertions deterministic.

export const NOW = Date.parse('2026-01-10T00:00:00Z');

// Tier-1 health lines: "<name>\t<unschedulable>\t<Type>=<Status>,...\n"
export const HEALTH_TEXT = [
    'node-ok\t\tMemoryPressure=False,DiskPressure=False,PIDPressure=False,Ready=True,',
    'node-mem\t\tMemoryPressure=True,DiskPressure=False,PIDPressure=False,Ready=True,',
    'node-cordon\ttrue\tMemoryPressure=False,DiskPressure=False,PIDPressure=False,Ready=True,',
    'node-down\t\tMemoryPressure=False,DiskPressure=False,PIDPressure=False,Ready=False,',
    'node-unknown\t\tMemoryPressure=Unknown,DiskPressure=Unknown,PIDPressure=Unknown,Ready=Unknown,',
    'node-net\t\tNetworkUnavailable=True,Ready=True,',
    '',   // trailing blank line, as kubectl emits
].join('\n');

// Tier-2 detail: a kubectl get nodes -o json payload as a JS object.
export const DETAIL_OBJ = {
    items: [
        {
            metadata: {
                name: 'cp-1',
                creationTimestamp: '2025-12-11T00:00:00Z',   // 30d before NOW
                labels: {'node-role.kubernetes.io/control-plane': ''},
            },
            spec: {},
            status: {
                conditions: [
                    {type: 'MemoryPressure', status: 'False'},
                    {type: 'DiskPressure', status: 'False'},
                    {type: 'PIDPressure', status: 'False'},
                    {type: 'Ready', status: 'True', lastTransitionTime: '2026-01-09T22:00:00Z'}, // 2h
                ],
                nodeInfo: {kubeletVersion: 'v1.34.6+k3s1'},
                capacity: {cpu: '4', memory: '8148256Ki'},
            },
        },
        {
            metadata: {
                name: 'worker-1',
                creationTimestamp: '2025-11-01T00:00:00Z',   // 70d before NOW
                labels: {},
            },
            spec: {},
            status: {
                conditions: [
                    {type: 'MemoryPressure', status: 'True'},
                    {type: 'Ready', status: 'True', lastTransitionTime: '2026-01-07T00:00:00Z'}, // 3d
                ],
                nodeInfo: {kubeletVersion: 'v1.34.6+k3s1'},
                capacity: {cpu: '8', memory: '16Gi'},
            },
        },
        {
            metadata: {
                name: 'worker-2',
                creationTimestamp: '2025-12-31T00:00:00Z',   // 10d before NOW
                labels: {},
            },
            spec: {unschedulable: true},
            status: {
                conditions: [
                    {type: 'MemoryPressure', status: 'False'},
                    {type: 'Ready', status: 'False', lastTransitionTime: '2026-01-09T23:15:00Z'}, // 45m
                ],
                nodeInfo: {kubeletVersion: 'v1.34.6+k3s1'},
                capacity: {cpu: '8', memory: '16Gi'},
            },
        },
    ],
};

// metrics-server payload: present for cp-1 and worker-1, absent for worker-2.
export const METRICS_OBJ = {
    items: [
        {metadata: {name: 'cp-1'}, usage: {cpu: '500m', memory: '2000000Ki'}},
        {metadata: {name: 'worker-1'}, usage: {cpu: '4', memory: '8Gi'}},
    ],
};

// Pod lines: "<phase>|<waitingReason>,...". One Running pod is also crashlooping.
export const PODS_TEXT = [
    'Running|',
    'Running|',
    'Pending|',
    'Failed|',
    'Running|CrashLoopBackOff,',
    'Succeeded|',
    '',
].join('\n');
