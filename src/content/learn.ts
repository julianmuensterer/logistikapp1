/** Learn-mode content (English). Values are rounded; see docs/PLAN.md for sources. */
export interface LearnCard {
  id: string;
  title: string;
  body: string;
}

export const LEARN_CARDS: LearnCard[] = [
  {
    id: 'overview',
    title: 'The Millau Viaduct',
    body: `<p>A multi-span <b>cable-stayed bridge</b> across the Tarn valley in southern France, opened in December 2004.
      It is <b>2,460 m</b> long with spans of 204 m + 6 × 342 m + 204 m. The deck lies about
      <b>270 m</b> above the river; the top of the highest pylon is about <b>343 m</b> above the ground.</p>
      <p>Total weight: about <b>290,000 t</b>.</p>
      <p class="hint">Click on a part of the bridge to learn more about it.</p>`,
  },
  {
    id: 'deck',
    title: 'Deck: steel box girder',
    body: `<p>The deck is a <b>steel box girder with an orthotropic deck plate</b>, 32 m wide and only 4.2 m deep.
      It weighs about <b>36,000 t</b> and is made of structural steel <b>S355</b> and <b>S460</b>.</p>
      <p><b>Role in the load path:</b> carries the traffic and its own weight in bending between the stay anchors
      and passes the loads to the stays. Under wind it bends sideways between the piers.</p>
      <p><b>FE model:</b> Euler-Bernoulli beam elements, A ≈ 1.5 m², I ≈ 4.5 m⁴ (vertical), I ≈ 70 m⁴ (lateral).</p>
      <p>The aerofoil-like shape and the 3 m wind screens were optimised in wind-tunnel tests.</p>`,
  },
  {
    id: 'stay',
    title: 'Stay cables',
    body: `<p><b>154 stays</b>, 11 on each side of each of the 7 pylons, in a single central plane (semi-harp layout).
      Each stay has <b>55 to 91 parallel strands</b> of high-strength prestressing steel (150 mm² per strand,
      tensile strength f<sub>uk</sub> = 1,860 MPa). The longest stay is about 180 m.</p>
      <p><b>Role in the load path:</b> elastic supports for the deck; they pull the deck up towards the pylon tops.</p>
      <p><b>FE model:</b> truss elements (axial force only). In the real bridge the stays are pre-tensioned so that the
      deck reaches its target shape under self-weight. The model applies a pretension force to every stay that lifts the deck weight of its
      tributary length (12.5 m between anchors, more for the outermost stays), and the self-weight case is solved together with it (G+PT).</p>`,
  },
  {
    id: 'pylon',
    title: 'Pylons',
    body: `<p>7 steel pylons, each about <b>87 m</b> above the deck, shaped like an inverted Y. Together they weigh
      about 4,600 t (S355 / S460).</p>
      <p><b>Role in the load path:</b> collect the stay forces. The horizontal components of the stays on both sides
      balance each other; the vertical components go down into the pier as compression.</p>
      <p><b>FE model:</b> beam elements rigidly connected to the deck.</p>`,
  },
  {
    id: 'pier',
    title: 'Piers: reinforced concrete',
    body: `<p>7 tapered piers of high-performance <b>reinforced concrete</b>. Heights: P1 94.5 m, <b>P2 245 m</b>
      (the tallest bridge pier in the world at opening), P3 221 m, P4 144 m, P5 136 m, P6 112 m, P7 78 m.
      About 53,000 m³ of concrete and 10,000 t of reinforcement.</p>
      <p>The upper ~90 m of each pier are <b>split into two thinner legs</b>. This makes the piers flexible in the
      longitudinal direction, so the 2.5 km long deck can expand with temperature without large restraint forces,
      while the piers stay stiff in the transverse direction against wind.</p>
      <p><b>FE model:</b> beam elements clamped at the foundation; laterally they act as springs supporting the deck.</p>`,
  },
  {
    id: 'loads',
    title: 'Loads and the FE model',
    body: `<p><b>Self-weight G:</b> deck ≈ 200 kN/m (steel, asphalt, barriers), pylons ≈ 74 kN/m, piers from concrete volume.</p>
      <p><b>Traffic Q:</b> a uniform area load q [kN/m²] on a 24 m wide strip of the deck. 1 kN/m² over the whole bridge
      is 59 MN ≈ 6,000 t.</p>
      <p><b>Wind W:</b> pressure q<sub>w</sub> = ½ ρ v² acting on deck, pylons and piers with drag coefficients c<sub>d</sub>.</p>
      <p><b>Solution:</b> two plane frame models (elevation and plan) are assembled into K u = f and solved with a Cholesky
      factorisation. Because the model is linear, the tolerable traffic load is found by scaling the unit traffic case
      until the first element reaches 100 % utilisation.</p>
      <p><b>Partial safety factors</b> (toggle): γ<sub>G</sub> = 1.35, γ<sub>Q</sub> = 1.5, γ<sub>W</sub> = 1.5,
      γ<sub>M0</sub> = 1.0 (steel), γ<sub>M</sub> = 1.5 (strands), γ<sub>c</sub> = 1.5 with α<sub>cc</sub> = 0.85 (concrete).</p>
      <p class="hint">Simplified teaching model. The real bridge is far safer than this game.</p>`,
  },
  {
    id: 'sources',
    title: 'Sources',
    body: `<ul class="sources">
      <li><a href="https://structurae.net/en/structures/millau-viaduct" target="_blank" rel="noopener">Structurae: Millau Viaduct</a></li>
      <li><a href="https://www.freyssinet.com/case-study/millau-viaduct-construction/" target="_blank" rel="noopener">Freyssinet: Millau Viaduct construction</a></li>
      <li><a href="https://en.dillinger.de/app/uploads/2024/03/20160211043536-millau_e.pdf" target="_blank" rel="noopener">Dillinger: heavy plate for the Viaduc de Millau (PDF)</a></li>
      <li><a href="https://roadtraffic-technology.com/projects/millau_viaduct" target="_blank" rel="noopener">Road Traffic Technology: Millau Viaduct</a></li>
      <li><a href="https://www.fzt.haw-hamburg.de/pers/Scholz/dglr/hh/text_2010_10_28_Millau_Viaduct.pdf" target="_blank" rel="noopener">HAW Hamburg / DGLR: Millau Viaduct (PDF)</a></li>
    </ul>`,
  },
];

export const FAILURE_TEXT: Record<string, string> = {
  stay: 'The stay cable was stretched beyond its tensile strength and snapped. The deck lost one of its elastic supports.',
  deck: 'The steel box girder reached its yield strength in bending. Vertical traffic bending and lateral wind bending add up in the outer fibres of the deck.',
  pylon: 'The steel pylon yielded. Unbalanced stay forces and wind bend the pylon like a cantilever.',
  pier: 'The concrete pier was crushed. Wind pushes the deck sideways and the tall pier has to carry this as a huge bending moment down to its foundation.',
};
