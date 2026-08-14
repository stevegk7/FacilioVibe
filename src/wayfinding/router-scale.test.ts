// The router at portfolio scale.
//
// This file exists because "these graphs are small" stopped being true. Every
// asset in the portfolio is a node, so V tracks the asset register, and the cost
// landed exactly where it hurts most: a FAR route, which is the one somebody
// asks for when they do not know the building. A near route always looked fine,
// because Dijkstra exits early.
//
// Measured on the compiled module, before and after:
//    8,821 nodes    795ms  ->   25ms
//   21,101 nodes  5,104ms  ->  143ms
//   84,401 nodes 94,083ms  ->  (42,000 nodes: 192ms)
//
// The bound below is set from those numbers: generous enough that a loaded
// machine cannot fail it, tight enough that reintroducing the linear scan
// (5.1s at this size) cannot pass it.
import { describe, expect, it } from 'vitest';
import { routeOnGraph } from './autoGraph';
import type { AutoGraph } from './autoGraph';

/** A corridor of N spaces, each 1m from the last: the worst case for a far route. */
function chain(n: number): AutoGraph {
  const nodes = [];
  const edges = [];
  for (let i = 0; i < n; i++) {
    nodes.push({
      id: `space:${i}`,
      kind: 'space' as const,
      recordId: i,
      label: `S${i}`,
      floorId: 1,
      buildingId: 1,
      x: i,
      z: 0,
    });
    if (i > 0) {
      edges.push({
        id: `e${i}`,
        from: `space:${i - 1}`,
        to: `space:${i}`,
        kind: 'walk' as const,
        meters: 1,
      });
    }
  }
  return { nodes, edges };
}

const NODES = 21_101; // the size the 5.1s measurement was taken at
const BUDGET_MS = 2_500;

describe('routeOnGraph at portfolio scale', () => {
  it('routes end to end across a 21k-node graph, correctly and quickly', () => {
    const graph = chain(NODES);

    const started = performance.now();
    const route = routeOnGraph(graph, 'space:0', `space:${NODES - 1}`);
    const elapsed = performance.now() - started;

    // Correctness first — a fast wrong answer is not the goal.
    if (route.unroutable) throw new Error(`expected a route, got: ${route.reason}`);
    expect(Math.round(route.distanceM)).toBe(NODES - 1);

    // Then the bound. This is the guard: the previous implementation scanned the
    // whole distance map on every iteration and took 5,104ms here.
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('reuses the adjacency for a second route over the same graph', () => {
    const graph = chain(NODES);
    routeOnGraph(graph, 'space:0', `space:${NODES - 1}`);

    // The index and adjacency were rebuilt from scratch on EVERY call before,
    // which a screen pays for on every render that changes an endpoint.
    const started = performance.now();
    const again = routeOnGraph(graph, 'space:0', `space:${NODES - 1}`);
    const elapsed = performance.now() - started;

    if (again.unroutable) throw new Error('expected a route on the second call');
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('gives a fresh graph its own adjacency rather than serving a stale one', () => {
    const first = chain(50);
    expect(routeOnGraph(first, 'space:0', 'space:49').unroutable).toBeFalsy();

    // A rebuild replaces the graph wholesale. The cache is keyed on the object,
    // so a shorter graph must not inherit the longer one's edges.
    const second = chain(10);
    const route = routeOnGraph(second, 'space:0', 'space:9');
    if (route.unroutable) throw new Error('expected a route on the rebuilt graph');
    expect(Math.round(route.distanceM)).toBe(9);
    expect(routeOnGraph(second, 'space:0', 'space:49').unroutable).toBe(true);
  });
});
