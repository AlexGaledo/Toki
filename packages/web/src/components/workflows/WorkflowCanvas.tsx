import { useMemo } from 'react';
import { Plus } from 'lucide-react';
import {
  BaseEdge, Background, BackgroundVariant, EdgeLabelRenderer, Handle, Position, ReactFlow, getStraightPath,
  type Edge, type EdgeProps, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import './WorkflowCanvas.css';
import type { WorkflowNode, WorkflowStepResult } from '@pocketrocket/shared';
import { Button, Menu, MenuContent, MenuItem } from '../ui';
import { KIND_LABEL, describeStep, type StepContext } from '../../lib/workflows';
import { StepCard, StepMenu, type StepOps } from './StepCard';
import { useNewPages } from '../PageHeader';

export interface CanvasProps {
  steps: WorkflowNode[];
  ctx: StepContext;
  results: Map<string, WorkflowStepResult>;
  selectedId: string | null;
  problems: Record<string, string[]>;
  ops: StepOps;
  readOnly: boolean;
  vertical: boolean;
  onInsert: (index: number, kind: 'agent' | 'approval' | 'output') => void;
}

const NODE_W = 248;
const NODE_H = 104;
const GAP = 72;
const FIT_STEPS = 3;
const FIT_MIN_ZOOM = 0.7;

interface StepData extends Record<string, unknown> {
  step: WorkflowNode; index: number; steps: WorkflowNode[]; ctx: StepContext; result?: WorkflowStepResult;
  selected: boolean; problems?: string[]; ops: StepOps; readOnly: boolean; vertical: boolean;
}
type StepNodeT = Node<StepData, 'step'>;
interface PlusData extends Record<string, unknown> { index: number; onInsert: CanvasProps['onInsert']; readOnly: boolean }
type PlusEdgeT = Edge<PlusData, 'plus'>;

function StepNodeView({ data }: NodeProps<StepNodeT>) {
  const d = data;
  const label = 'step ' + (d.index + 1) + ', ' + describeStep(d.step, d.ctx).title;
  return (
    <div style={{ width: NODE_W }}>
      <Handle type="target" position={d.vertical ? Position.Top : Position.Left} isConnectable={false} />
      <StepCard
        step={d.step} index={d.index} total={d.steps.length} ctx={d.ctx} result={d.result} selected={d.selected} problems={d.problems} compact
        actions={(
          <span className="nodrag nopan flex shrink-0 items-center" onClick={(e) => e.stopPropagation()}>
            {!d.readOnly && (
              <>
                <Button size="sm" variant="ghost" className="-my-1.5 h-7" aria-label={'Edit ' + label} onClick={() => d.ops.onEdit(d.step.id)}>Edit</Button>
                <StepMenu steps={d.steps} index={d.index} ops={d.ops} label={label} />
              </>
            )}
          </span>
        )}
      />
      <Handle type="source" position={d.vertical ? Position.Bottom : Position.Right} isConnectable={false} />
    </div>
  );
}

function PlusEdgeView({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<PlusEdgeT>) {
  const [path, labelX, labelY] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  const index = data?.index ?? 1;
  return (
    <>
      <BaseEdge id={id} path={path} />
      {!data?.readOnly && (
        <EdgeLabelRenderer>
          <div className="nodrag nopan absolute" style={{ transform: 'translate(-50%, -50%) translate(' + labelX + 'px,' + labelY + 'px)', pointerEvents: 'all' }}>
            <Menu.Root>
              <Menu.Trigger asChild>
                <Button size="icon" className="h-7 w-7 rounded-full bg-panel shadow-[var(--shadow-sm)] ring-1 ring-line" aria-label={'Add a step after step ' + index}>
                  <Plus size={14} aria-hidden />
                </Button>
              </Menu.Trigger>
              <MenuContent align="center">
                <MenuItem onSelect={() => data?.onInsert(index, 'agent')}>A bot does something</MenuItem>
                {index >= 2 && <MenuItem onSelect={() => data?.onInsert(index, 'approval')}>You approve</MenuItem>}
                <MenuItem onSelect={() => data?.onInsert(index, 'output')}>Output</MenuItem>
              </MenuContent>
            </Menu.Root>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { step: StepNodeView };
const edgeTypes = { plus: PlusEdgeView };

export default function WorkflowCanvas({ steps, ctx, results, selectedId, problems, ops, readOnly, vertical, onInsert }: CanvasProps) {
  const { nodes, edges } = useMemo(() => {
    const nodes: StepNodeT[] = steps.map((step, i) => ({
      id: step.id,
      type: 'step',
      position: vertical ? { x: 0, y: i * (NODE_H + GAP) } : { x: i * (NODE_W + GAP), y: 0 },
      initialWidth: NODE_W,
      initialHeight: NODE_H,
      ariaLabel: 'Step ' + (i + 1) + ' of ' + steps.length + ': ' + describeStep(step, ctx).title + ', ' + KIND_LABEL[step.kind].toLowerCase(),
      data: { step, index: i, steps, ctx, result: results.get(step.id), selected: step.id === selectedId, problems: problems[step.id], ops, readOnly, vertical },
    }));
    const edges: PlusEdgeT[] = steps.slice(1).map((step, i) => ({
      id: steps[i].id + '->' + step.id, source: steps[i].id, target: step.id, type: 'plus',
      data: { index: i + 1, onInsert: (at, kind) => onInsert(at, kind), readOnly },
    }));
    return { nodes, edges };
  }, [steps, ctx, results, selectedId, problems, ops, readOnly, vertical, onInsert]);

  const shared = useNewPages();
  const height = vertical ? Math.min(Math.max(steps.length * (NODE_H + GAP), 320), 680) : 340;
  return (
    <div role="group" aria-label="Workflow canvas" className={'wf-canvas overflow-hidden rounded-lg ring-1 ring-line' + (shared ? ' pr-canvas' : '')} style={{ height }}>
      <ReactFlow<StepNodeT, PlusEdgeT>
        key={(vertical ? 'v' : 'h') + steps.length}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1, minZoom: FIT_MIN_ZOOM, nodes: nodes.slice(0, FIT_STEPS).map((n) => ({ id: n.id })) }}
        minZoom={0.3}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        elementsSelectable={!readOnly}
        zoomOnScroll={false}
        panOnScroll
        zoomOnDoubleClick={false}
        onNodeClick={(_, n) => { if (!readOnly) ops.onEdit(n.id); }}
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1.5} />
      </ReactFlow>
    </div>
  );
}
