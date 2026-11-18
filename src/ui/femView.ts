import { BRIDGE_LENGTH, type BridgeModel, type Evaluation } from '../fem/bridge';
import { etaColor } from '../scene/bridge3d';
import { groundAt } from '../scene/world';

const NS = 'http://www.w3.org/2000/svg';

/** 2D view of the finite element mesh with deformed shape and utilisation colours. */
export class FemView {
  private svg: SVGSVGElement;
  private lines: SVGLineElement[] = [];
  private tip: HTMLElement;
  private model: BridgeModel;
  private last?: Evaluation;
  private extraForces?: (element: number) => string;

  constructor(svg: SVGSVGElement, tip: HTMLElement, model: BridgeModel) {
    this.svg = svg;
    this.tip = tip;
    this.model = model;
    svg.innerHTML = '';
    const yMin = -250, yMax = 95;
    svg.setAttribute('viewBox', `-20 ${-yMax} ${BRIDGE_LENGTH + 40} ${yMax - yMin}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    const ground = document.createElementNS(NS, 'path');
    ground.setAttribute('fill', '#e9f3dc');
    let d = `M -20 ${-yMin}`;
    for (let x = -20; x <= BRIDGE_LENGTH + 20; x += 20) d += ` L ${x} ${-groundAt(x)}`;
    ground.setAttribute('d', d + ` L ${BRIDGE_LENGTH + 20} ${-yMin} Z`);
    svg.appendChild(ground);
    for (const e of model.elements) {
      const l = document.createElementNS(NS, 'line');
      l.setAttribute('stroke-width', e.part === 'stay' ? '1.5' : e.part === 'pier' ? '7' : '4');
      l.setAttribute('vector-effect', 'non-scaling-stroke');
      l.style.strokeWidth = e.part === 'stay' ? '1.2px' : e.part === 'pier' ? '4px' : '2.5px';
      l.dataset.element = String(e.index);
      svg.appendChild(l);
      this.lines[e.index] = l;
    }
    // nodes
    const v = model.vertical;
    const nodesGroup = document.createElementNS(NS, 'g');
    nodesGroup.setAttribute('fill', '#1f2a44');
    svg.appendChild(nodesGroup);
    this.nodeDots = v.nodes.map(() => {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('r', '2.2');
      nodesGroup.appendChild(c);
      return c;
    });
    // removed stays: dashed lines
    for (const c of model.cutStayGeometry) {
      const l = document.createElementNS(NS, 'line');
      const a = v.nodes[c.deckNode], b = v.nodes[c.topNode];
      l.setAttribute('x1', String(a.x)); l.setAttribute('y1', String(-a.y));
      l.setAttribute('x2', String(b.x)); l.setAttribute('y2', String(-b.y));
      l.setAttribute('stroke', '#ff7a59');
      l.setAttribute('vector-effect', 'non-scaling-stroke');
      l.style.strokeWidth = '1px';
      l.setAttribute('stroke-dasharray', '3 3');
      svg.appendChild(l);
    }
    this.onMove = (ev) => this.hover(ev);
    this.onLeave = () => (this.tip.style.display = 'none');
    this.onClick = (ev) => {
      const idx = (ev.target as SVGElement).dataset?.element;
      if (idx !== undefined) this.elementClick?.(Number(idx));
    };
    svg.addEventListener('mousemove', this.onMove);
    svg.addEventListener('mouseleave', this.onLeave);
    svg.addEventListener('click', this.onClick);
  }

  private nodeDots: SVGCircleElement[];
  private onMove: (ev: MouseEvent) => void;
  private onLeave: () => void;
  private onClick: (ev: MouseEvent) => void;
  /** called when an element is clicked (used by the scissors) */
  elementClick?: (element: number) => void;

  dispose(): void {
    this.svg.removeEventListener('mousemove', this.onMove);
    this.svg.removeEventListener('mouseleave', this.onLeave);
    this.svg.removeEventListener('click', this.onClick);
    this.tip.style.display = 'none';
  }

  setForceText(fn: (element: number) => string): void {
    this.extraForces = fn;
  }

  update(ev: Evaluation, scale: number, disp: (dof: number) => number = ev.displacement): void {
    this.last = ev;
    const v = this.model.vertical;
    const pos = v.nodes.map((n, k) => ({ x: n.x + disp(k * 3) * scale, y: n.y + disp(k * 3 + 1) * scale }));
    for (const e of this.model.elements) {
      const el = v.elements[e.index];
      const l = this.lines[e.index];
      l.setAttribute('x1', String(pos[el.i].x));
      l.setAttribute('y1', String(-pos[el.i].y));
      l.setAttribute('x2', String(pos[el.j].x));
      l.setAttribute('y2', String(-pos[el.j].y));
      l.setAttribute('stroke', '#' + etaColor(ev.eta[e.index]).getHexString());
    }
    pos.forEach((p, k) => {
      this.nodeDots[k].setAttribute('cx', String(p.x));
      this.nodeDots[k].setAttribute('cy', String(-p.y));
    });
  }

  private hover(ev: MouseEvent): void {
    const target = ev.target as SVGElement;
    const idx = target.dataset?.element;
    if (idx === undefined || !this.last) {
      this.tip.style.display = 'none';
      return;
    }
    const e = this.model.element(Number(idx));
    const eta = this.last.eta[e.index];
    this.tip.innerHTML = `<b>${e.label}</b><br>${this.extraForces?.(e.index) ?? ''}Utilisation: ${(eta * 100).toFixed(0)} %`;
    const box = this.svg.parentElement!.getBoundingClientRect();
    this.tip.style.display = 'block';
    this.tip.style.left = `${Math.min(ev.clientX - box.left + 12, box.width - 280)}px`;
    this.tip.style.top = `${ev.clientY - box.top - 60}px`;
  }
}
