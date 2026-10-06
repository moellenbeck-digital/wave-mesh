"use client";

import { type PointerEvent, useRef, useState } from "react";
import { useLocale } from "@/components/locale-provider";
import { aclMessages } from "@/i18n/acl";
import { ALL_SERVICES, type Edge, type GraphNode, NODE_H, NODE_W, VIEW_W } from "./model";

type Point = { x: number; y: number };

/** Fill and stroke per kind: what is derived (roles, `*`) is dashed, what is drawn is solid. */
const BOX: Record<GraphNode["kind"], { fill: string; stroke: string; dash?: string }> = {
  user: { fill: "#ffffff", stroke: "#0f27441f" },
  group: { fill: "#fbfdfd", stroke: "#0f6e6e40" },
  role: { fill: "#fffdf8", stroke: "#0f274433", dash: "4 3" },
  any: { fill: "#fffdf8", stroke: "#0f274433", dash: "4 3" },
  tag: { fill: "#f6f7f9", stroke: "#0f27441f" },
  svc: { fill: "#f2f8f8", stroke: "#0f6e6e33" },
};

const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const center = (p: Point): Point => ({ x: p.x + NODE_W / 2, y: p.y + NODE_H / 2 });

/** Where the line from a card's centre towards `toward` leaves the card. */
function exitPoint(p: Point, toward: Point, pad = 3): Point {
  const c = center(p);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (!dx && !dy) return c;
  const t = Math.min((NODE_W / 2 + pad) / Math.abs(dx || 1e-9), (NODE_H / 2 + pad) / Math.abs(dy || 1e-9));
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/** A curve when the opposite arrow exists too, so both stay visible and clickable. */
function edgePath(a: Point, b: Point, twin: boolean) {
  const ca = center(a);
  const cb = center(b);
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  const len = Math.hypot(dx, dy) || 1;
  const off = twin ? 30 : 0;
  const ctrl = { x: (ca.x + cb.x) / 2 + (-dy / len) * off, y: (ca.y + cb.y) / 2 + (dx / len) * off };
  const p0 = exitPoint(a, ctrl);
  const p2 = exitPoint(b, ctrl, 7);
  const mid = { x: 0.25 * p0.x + 0.5 * ctrl.x + 0.25 * p2.x, y: 0.25 * p0.y + 0.5 * ctrl.y + 0.25 * p2.y };
  return { d: `M${p0.x},${p0.y} Q${ctrl.x},${ctrl.y} ${p2.x},${p2.y}`, mid };
}

type Drag =
  | { type: "move"; id: string; offset: Point; start: Point; moved: boolean }
  | { type: "connect"; src: string; start: Point; at: Point; moved: boolean; over: string | null };

export interface GraphProps {
  nodes: GraphNode[];
  positions: Record<string, Point>;
  height: number;
  edges: Edge[];
  /** True draws the full mesh behind the cards: no policy, everything reaches everything. */
  mesh: boolean;
  subtitles: Record<string, string>;
  isolated: Set<string>;
  selectedEdge: string | null;
  selectedNode: string | null;
  pending: string | null;
  onMove: (id: string, to: Point) => void;
  onMoved: () => void;
  onConnect: (src: string, dst: string) => void;
  onSelectEdge: (id: string) => void;
  onTapNode: (id: string) => void;
  onTapHandle: (id: string) => void;
  onBackground: () => void;
}

export function Graph(props: GraphProps) {
  const { nodes, positions, edges, height } = props;
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const t = aclMessages(useLocale());

  function toSvg(event: PointerEvent): Point {
    const el = svg.current;
    const matrix = el?.getScreenCTM();
    if (!el || !matrix) return { x: 0, y: 0 };
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: p.x, y: p.y };
  }

  function nodeAt(p: Point): string | null {
    for (const node of [...nodes].reverse()) {
      const pos = positions[node.id];
      if (
        pos &&
        p.x >= pos.x - 6 &&
        p.x <= pos.x + NODE_W + 10 &&
        p.y >= pos.y - 6 &&
        p.y <= pos.y + NODE_H + 6
      ) {
        return node.id;
      }
    }
    return null;
  }

  function onPointerDown(event: PointerEvent<SVGSVGElement>) {
    const target = event.target as Element;
    const handle = target.closest("[data-handle]")?.getAttribute("data-handle");
    const node = target.closest("[data-node]")?.getAttribute("data-node");
    const edge = target.closest("[data-edge]")?.getAttribute("data-edge");
    const p = toSvg(event);
    if (handle) {
      setDrag({ type: "connect", src: handle, start: p, at: p, moved: false, over: null });
    } else if (node) {
      const pos = positions[node] ?? { x: 0, y: 0 };
      setDrag({ type: "move", id: node, offset: { x: p.x - pos.x, y: p.y - pos.y }, start: p, moved: false });
    } else if (edge) {
      props.onSelectEdge(edge);
      return;
    } else {
      props.onBackground();
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent<SVGSVGElement>) {
    if (!drag) return;
    const p = toSvg(event);
    const moved = drag.moved || Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 4;
    if (drag.type === "move") {
      if (moved) {
        props.onMove(drag.id, {
          x: Math.max(0, Math.min(VIEW_W - NODE_W - 12, p.x - drag.offset.x)),
          y: Math.max(0, Math.min(height - NODE_H, p.y - drag.offset.y)),
        });
      }
      setDrag({ ...drag, moved });
    } else {
      setDrag({ ...drag, moved, at: p, over: nodeAt(p) });
    }
  }

  function onPointerUp(event: PointerEvent<SVGSVGElement>) {
    if (!drag) return;
    setDrag(null);
    if (drag.type === "move") {
      if (drag.moved) props.onMoved();
      else props.onTapNode(drag.id);
      return;
    }
    // A tap on the dot starts a connection that the next tap on a card ends --
    // the way to draw one on a phone, where there is nothing to drag with.
    if (!drag.moved) {
      props.onTapHandle(drag.src);
      return;
    }
    const target = nodeAt(toSvg(event));
    if (target && target !== drag.src) props.onConnect(drag.src, target);
  }

  const has = (src: string, dst: string) => edges.some((e) => e.src === src && e.dst === dst);
  const concrete = nodes.filter(
    (n) => n.kind === "user" || n.kind === "tag" || (n.kind === "svc" && n.id !== ALL_SERVICES),
  );

  return (
    <svg
      ref={svg}
      viewBox={`0 0 ${VIEW_W} ${height}`}
      role="img"
      aria-label={t.graphLabel}
      className="block h-auto w-full min-w-[680px] touch-none select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
    >
      <defs>
        <marker
          id="acl-arrow"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M0,0 L10,5 L0,10 z" fill="#0f274490" />
        </marker>
        <marker
          id="acl-arrow-sel"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M0,0 L10,5 L0,10 z" fill="#0f6e6e" />
        </marker>
      </defs>

      {props.mesh
        ? concrete.flatMap((a, i) =>
            concrete.slice(i + 1).map((b) => {
              const pa = positions[a.id];
              const pb = positions[b.id];
              if (!pa || !pb || (a.kind === "svc" && b.kind === "svc")) return null;
              const ca = center(pa);
              const cb = center(pb);
              return (
                <line
                  key={`${a.id}~${b.id}`}
                  x1={ca.x}
                  y1={ca.y}
                  x2={cb.x}
                  y2={cb.y}
                  stroke="#7c8b9a"
                  strokeOpacity={0.28}
                  strokeWidth={1.2}
                  strokeDasharray="3 4"
                />
              );
            }),
          )
        : null}

      {edges.map((edge) => {
        const a = positions[edge.src];
        const b = positions[edge.dst];
        if (!a || !b) return null;
        const { d, mid } = edgePath(a, b, has(edge.dst, edge.src));
        const selected = props.selectedEdge === edge.id;
        const label = short(edge.ports.length > 0 ? edge.ports.join(", ") : t.allPorts, 22);
        const width = label.length * 6.7 + 16;
        return (
          <g key={edge.id} data-edge={edge.id} className="cursor-pointer">
            <path
              d={d}
              fill="none"
              stroke={selected ? "#0f6e6e" : "#0f274470"}
              strokeWidth={selected ? 2.6 : 1.8}
              markerEnd={`url(#${selected ? "acl-arrow-sel" : "acl-arrow"})`}
            />
            <path d={d} fill="none" stroke="transparent" strokeWidth={16} />
            <g transform={`translate(${mid.x - width / 2},${mid.y - 10})`}>
              <rect
                width={width}
                height={20}
                rx={10}
                fill={selected ? "#0f6e6e" : "#ffffff"}
                stroke={selected ? "#0f6e6e" : "#0f27441f"}
              />
              <text
                x={width / 2}
                y={14}
                textAnchor="middle"
                fontSize={11}
                fontWeight={500}
                className={edge.ports.length > 0 ? "font-mono" : "font-sans"}
                fill={selected ? "#ffffff" : edge.ports.length > 0 ? "#0f2744" : "#7c8b9a"}
              >
                {label}
              </text>
            </g>
          </g>
        );
      })}

      {drag?.type === "connect" && drag.moved
        ? (() => {
            const from = positions[drag.src];
            if (!from) return null;
            return (
              <path
                d={`M${from.x + NODE_W},${from.y + NODE_H / 2} L${drag.at.x},${drag.at.y}`}
                stroke="#0f6e6e"
                strokeWidth={2}
                strokeDasharray="5 4"
                fill="none"
                pointerEvents="none"
              />
            );
          })()
        : null}

      {nodes.map((node) => {
        const pos = positions[node.id];
        if (!pos) return null;
        const box = BOX[node.kind];
        const active =
          props.selectedNode === node.id ||
          props.pending === node.id ||
          (drag?.type === "connect" && drag.src === node.id);
        const target = drag?.type === "connect" && drag.over === node.id && drag.over !== drag.src;
        const stroke = active || target ? "#0f6e6e" : props.isolated.has(node.id) ? "#dc262650" : box.stroke;
        const kind =
          node.kind === "user" && node.role
            ? `${t.kindLabel("user")} · ${node.role.toUpperCase()}`
            : t.kindLabel(node.kind);
        return (
          <g
            key={node.id}
            data-node={node.id}
            transform={`translate(${pos.x},${pos.y})`}
            className={
              drag?.type === "move" && drag.id === node.id && drag.moved ? "cursor-grabbing" : "cursor-grab"
            }
          >
            <title>{node.id}</title>
            <rect
              width={NODE_W}
              height={NODE_H}
              rx={10}
              fill={box.fill}
              stroke={stroke}
              strokeWidth={active || target ? 2 : 1}
              strokeDasharray={target ? "4 3" : active ? undefined : box.dash}
            />
            <text
              x={14}
              y={19}
              fontSize={9.5}
              fontWeight={700}
              letterSpacing="0.08em"
              fill={node.kind === "svc" || node.kind === "group" ? "#0f6e6e" : "#7c8b9a"}
            >
              {kind}
            </text>
            <text x={14} y={38} fontSize={14} fontWeight={600} className="font-display" fill="#0f2744">
              {short(node.kind === "user" ? node.id.slice(5) : node.id === "*" ? t.anyCard : node.id, 22)}
            </text>
            <text x={14} y={54} fontSize={11.5} fill="#7c8b9a">
              {short(props.subtitles[node.id] ?? "…", 30)}
            </text>
            {node.kind === "svc" ? null : (
              <g data-handle={node.id} className="cursor-crosshair">
                <circle cx={NODE_W} cy={NODE_H / 2} r={15} fill="transparent" />
                <circle
                  cx={NODE_W}
                  cy={NODE_H / 2}
                  r={6.5}
                  fill={props.pending === node.id ? "#0f6e6e" : "#ffffff"}
                  stroke="#0f6e6e"
                  strokeWidth={2}
                />
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}
