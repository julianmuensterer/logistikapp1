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
    svg.addEventListener('mousemove', (ev) => this.hover(ev));
    svg.addEventListener('mouseleave', () => (this.tip.style.display = 'none'));
  }

  private nodeDots: SVGCircleElement[];

  setForceText(fn: (element: number) => string): void {
    this.extraForces = fn;
  }

  update(ev: Evaluation, scale: number): void {
    this.last = ev;
    const v = this.model.vertical;
    const pos = v.nodes.map((n, k) => ({ x: n.x + ev.displacement(k * 3) * scale, y: n.y + ev.displacement(k * 3 + 1) * scale }));
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
