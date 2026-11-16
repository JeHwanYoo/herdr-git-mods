const LANE_CELLS = 2;
export const ROW_HEIGHT = 2;

interface Edge {
  from: number;
  to: number;
  color: number;
}

export interface LayoutRow {
  column: number;
  color: number;
  uncommitted: boolean;
  above: (number | null)[];
  edges: Edge[];
}

export interface LayoutNode {
  sha: string;
  parents: readonly string[];
}

interface Lane {
  sha: string;
  color: number;
}

function vacant(lanes: (Lane | null)[]): number {
  const index = lanes.indexOf(null);
  if (index >= 0) return index;
  lanes.push(null);
  return lanes.length - 1;
}

function laneOf(lanes: (Lane | null)[], sha: string): number {
  return lanes.findIndex((lane) => lane?.sha === sha);
}

class Builder {
  lanes: (Lane | null)[] = [];
  nextColor = 0;

  row(node: LayoutNode): LayoutRow {
    const lanes = this.lanes;
    const found = laneOf(lanes, node.sha);
    const column = found >= 0 ? found : vacant(lanes);
    const color = lanes[column]?.color ?? this.nextColor++;
    const above = lanes.map((lane) => lane?.color ?? null);
    const edges: Edge[] = [];
    lanes.forEach((lane, index) => {
      if (lane && index !== column) edges.push({ from: index, to: index, color: lane.color });
    });
    lanes[column] = null;
    node.parents.forEach((parent, index) => {
      if (node.parents.indexOf(parent) !== index) return;
      const to = this.parentLane(parent, index, column, color, edges);
      edges.push({ from: column, to, color: lanes[to]?.color ?? color });
    });
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    return { column, color, uncommitted: node.sha === "", above, edges };
  }

  private parentLane(parent: string, index: number, column: number, color: number, edges: Edge[]): number {
    const lanes = this.lanes;
    const existing = laneOf(lanes, parent);
    if (existing >= 0 && index === 0 && existing > column) {
      const moved = lanes[existing];
      lanes[existing] = null;
      lanes[column] = moved ? { sha: moved.sha, color } : null;
      const edge = edges.find((entry) => entry.from === existing);
      if (edge) edge.to = column;
      return column;
    }
    if (existing >= 0) return existing;
    const to = index === 0 && lanes[column] === null ? column : vacant(lanes);
    lanes[to] = { sha: parent, color: index === 0 ? color : this.nextColor++ };
    return to;
  }
}

export function buildLayout(nodes: Iterable<LayoutNode>): LayoutRow[] {
  const builder = new Builder();
  const rows: LayoutRow[] = [];
  for (const node of nodes) rows.push(builder.row(node));
  return rows;
}

export function layoutWidth(rows: readonly LayoutRow[], first: number, count: number): number {
  let lanes = 1;
  for (const row of rows.slice(first, first + count)) {
    lanes = Math.max(lanes, row.above.length, row.column + 1);
    for (const edge of row.edges) lanes = Math.max(lanes, edge.from + 1, edge.to + 1);
  }
  return lanes * LANE_CELLS + 1;
}

export function laneCell(column: number): number {
  return column * LANE_CELLS + 1;
}
