import { mkdir, writeFile } from "node:fs/promises";

const USERNAME = process.env.GITHUB_USER || "KaiqueCh";
const TOKEN = process.env.GITHUB_TOKEN;

if (!TOKEN) {
  console.error("GITHUB_TOKEN não encontrado.");
  process.exit(1);
}

/* =========================================================
   CONFIGURAÇÃO VISUAL
========================================================= */

// Semente do aleatório: muda a cada dia (rodar 2x no mesmo dia gera o mesmo desenho)
const SEED = process.env.SNAKE_SEED || new Date().toISOString().slice(0, 10);

// Grade
const CELL = 10;
const GAP = 4;
const STEP = CELL + GAP;
const OFFSET_X = 28;
const OFFSET_Y = 46;

// Tempo
const SPEED = 170;        // px por segundo
const MOVE_SHARE = 0.9;   // fração do ciclo com a cobra andando (o resto é pausa)
const FADE = 0.004;       // tempo que o quadrado leva para sumir
const REFILL_AT = 0.965;  // momento em que os quadrados voltam
const EAT_RADIUS = 8;     // distância (px) entre a cabeça e o quadrado para ele sumir

// Trajeto em zigue-zague
const ZZ_MIN_AMP = 2;     // altura mínima de cada traço, em linhas
const ZZ_MAX_SPAN = 4;    // colunas máximas por traço onde não há contribuições

// Corpo
const BODY = 112;         // comprimento em px (~8 quadrados)
const BODY_MAX_W = 9;     // espessura no pescoço
const BODY_MIN_W = 1.4;   // espessura na ponta do rabo
const LAYERS = 28;        // camadas do afinamento (mais = contorno mais liso)
const ENTRY = BODY + 30;  // px fora do gráfico para entrar e sair

// Paleta: violeta → ametista → orquídea (mesma família, luminância próxima,
// para o rabo não sumir no tema escuro nem virar um traço preto no claro)
const SNAKE_TAIL = "#6D28D9";
const SNAKE_MID = "#8B5CF6";
const SNAKE_FRONT = "#C084FC";
const HEAD_CORE = "#D8B4FE";
const HEAD_EDGE = "#9333EA";
const INK = "#2E1065";    // contorno dos olhos e narinas
const EYE = "#FACC15";
const PUPIL = "#1E0B36";
const TONGUE = "#FB7185";

// Zigue-zague do dorso (amplitude sorteada por vértice)
const ZIG_INK = "#4C1D95"; // tom escuro da mesma família: padrão integrado, sem "costura" preta
const ZIG_SPACING = 4.5;  // distância entre os vértices, em px
const ZIG_WIDTH = 1.1;
const ZIG_HEAD_GAP = 8;   // começa logo atrás da cabeça
const ZIG_LEN = BODY * 0.8;

// Cores dos quadrados (claro / escuro, iguais às do GitHub)
const LIGHT = ["#EBEDF0", "#9BE9A8", "#40C463", "#30A14E", "#216E39"];
const DARK = ["#161B22", "#0E4429", "#006D32", "#26A641", "#39D353"];

const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

/* =========================================================
   UTILITÁRIOS
========================================================= */

const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

function mix(a, b, t) {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return (
    "#" +
    ca.map((v, i) => Math.round(v + (cb[i] - v) * t).toString(16).padStart(2, "0")).join("")
  );
}

// Degradê de 3 cores: cauda → meio → frente
const snakeGradient = (t) =>
  t < 0.5 ? mix(SNAKE_TAIL, SNAKE_MID, t * 2) : mix(SNAKE_MID, SNAKE_FRONT, (t - 0.5) * 2);

const f5 = (n) => n.toFixed(5);

// Gerador pseudoaleatório com semente (FNV-1a + mulberry32)
function createRandom(seedText) {
  let state = 2166136261;
  for (const char of seedText) state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Distância de um ponto até o segmento a-b
function distanceToSegment(point, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * vx + (point.y - a.y) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(a.x + t * vx - point.x, a.y + t * vy - point.y);
}

const random = createRandom(SEED);
const randomInt = (min, max) => min + Math.floor(random() * (max - min + 1));

/* =========================================================
   BUSCA AS CONTRIBUIÇÕES REAIS DO GITHUB
========================================================= */

const query = `
query($login: String!) {
  user(login: $login) {
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks {
          contributionDays {
            date
            contributionCount
            weekday
          }
        }
      }
    }
  }
}
`;

const response = await fetch("https://api.github.com/graphql", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
    "User-Agent": "custom-contribution-snake",
  },
  body: JSON.stringify({ query, variables: { login: USERNAME } }),
});

if (!response.ok) {
  console.error(`Erro GitHub API: ${response.status} ${response.statusText}`);
  process.exit(1);
}

const result = await response.json();

if (result.errors) {
  console.error(JSON.stringify(result.errors, null, 2));
  process.exit(1);
}

const calendar = result.data?.user?.contributionsCollection?.contributionCalendar;

if (!calendar) {
  console.error("Não foi possível encontrar o calendário de contribuições.");
  process.exit(1);
}

const weeks = calendar.weeks;
const totalContributions = calendar.totalContributions;

const COLS = weeks.length;
const ROWS = 7;

const GRID_W = (COLS - 1) * STEP + CELL;
const GRID_H = (ROWS - 1) * STEP + CELL;
const WIDTH = OFFSET_X * 2 + GRID_W;
const HEIGHT = OFFSET_Y + GRID_H + 38;

/* =========================================================
   ORGANIZA OS DIAS E NÍVEIS
========================================================= */

const days = [];

weeks.forEach((week, weekIndex) => {
  week.contributionDays.forEach((day) => {
    days.push({
      ...day,
      x: OFFSET_X + weekIndex * STEP,
      y: OFFSET_Y + day.weekday * STEP,
      column: weekIndex,
      row: day.weekday,
    });
  });
});

const positiveCounts = days
  .filter((day) => day.contributionCount > 0)
  .map((day) => day.contributionCount)
  .sort((a, b) => a - b);

function percentile(array, p) {
  if (!array.length) return 0;
  return array[Math.floor((array.length - 1) * p)];
}

const Q1 = percentile(positiveCounts, 0.25);
const Q2 = percentile(positiveCounts, 0.5);
const Q3 = percentile(positiveCounts, 0.75);

function contributionLevel(count) {
  if (count === 0) return 0;
  if (count <= Q1) return 1;
  if (count <= Q2) return 2;
  if (count <= Q3) return 3;
  return 4;
}

/* =========================================================
   CAMINHO DA COBRA (zigue-zague aleatório)

   Atravessa o gráfico em traços diagonais com altura e largura
   sorteadas. Onde há contribuição, o traço é escolhido de forma
   a passar por todos os quadrados daquela coluna.
========================================================= */

const columnX = (column) => OFFSET_X + column * STEP + CELL / 2;
const rowY = (row) => OFFSET_Y + row * STEP + CELL / 2;
const center = (column, row) => ({ x: columnX(column), y: rowY(row) });

function zigzagTrack() {
  // Linhas com contribuição em cada coluna
  const targets = Array.from({ length: COLS }, () => []);

  for (const day of days) {
    if (day.contributionCount) targets[day.column].push(day.row);
  }

  // Os vértices ficam no vão entre duas colunas (fronteira 0..COLS)
  const apexPoint = (boundary, row) => ({ x: OFFSET_X + boundary * STEP - GAP / 2, y: rowY(row) });

  // O traço passa perto o bastante de todos os quadrados das colunas que atravessa?
  const covers = (from, to, firstColumn, lastColumn) => {
    for (let column = firstColumn; column <= lastColumn; column++) {
      for (const row of targets[column]) {
        if (distanceToSegment(center(column, row), from, to) > EAT_RADIUS - 0.5) return false;
      }
    }
    return true;
  };

  // O vértice também abre o próximo traço: precisa ficar além (acima ou
  // abaixo) de todos os quadrados da coluna seguinte
  const opensNext = (column, row, isBottom) =>
    column >= COLS || targets[column].every((r) => (isBottom ? r <= row : r >= row));

  const pick = (options) => options[Math.floor(random() * options.length)];

  let goingDown = random() < 0.5;
  let boundary = 0;

  // Primeiro vértice: topo (se o primeiro traço desce) ou base (se sobe)
  const firstRows = Array.from({ length: ROWS }, (_, r) => r).filter((r) =>
    goingDown
      ? r <= ROWS - 1 - ZZ_MIN_AMP && opensNext(0, r, false)
      : r >= ZZ_MIN_AMP && opensNext(0, r, true)
  );
  let row = pick(firstRows);

  const apexes = [apexPoint(0, row)];

  while (boundary < COLS) {
    const from = apexPoint(boundary, row);
    const options = [];

    // Todas as combinações válidas de largura e altura; o sorteio escolhe uma.
    // Traço de 1 coluna até a borda (linha 0 ou 6) é sempre válido.
    for (let span = 1; span <= Math.min(ZZ_MAX_SPAN, COLS - boundary); span++) {
      for (let next = 0; next < ROWS; next++) {
        const height = goingDown ? next - row : row - next;
        if (height < ZZ_MIN_AMP) continue;
        if (!opensNext(boundary + span, next, goingDown)) continue;
        if (!covers(from, apexPoint(boundary + span, next), boundary, boundary + span - 1)) continue;
        options.push({ span, next });
      }
    }

    const choice = pick(options);
    boundary += choice.span;
    row = choice.next;
    apexes.push(apexPoint(boundary, row));
    goingDown = !goingDown;
  }

  const first = apexes[0];
  const last = apexes[apexes.length - 1];

  return [{ x: first.x - ENTRY, y: first.y }, ...apexes, { x: last.x + ENTRY, y: last.y }];
}

const trackPoints = zigzagTrack();

const pathD = trackPoints.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ");

// Segmentos do trajeto, com a distância acumulada até o início de cada um
const segments = [];

for (let i = 1; i < trackPoints.length; i++) {
  const from = trackPoints[i - 1];
  const to = trackPoints[i];
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  if (!length) continue;

  const previous = segments[segments.length - 1];
  const start = previous ? previous.start + previous.length : 0;

  segments.push({ from, start, length, dx: (to.x - from.x) / length, dy: (to.y - from.y) / length });
}

const PATH_LENGTH = segments.reduce((sum, segment) => sum + segment.length, 0);
const BIG_GAP = PATH_LENGTH * 2;
const DURATION = Math.round(PATH_LENGTH / SPEED / MOVE_SHARE); // ciclo completo, em segundos

// Distância percorrida até a cabeça chegar a EAT_RADIUS do centro do quadrado
function reachDistance(point) {
  for (const segment of segments) {
    const wx = segment.from.x - point.x;
    const wy = segment.from.y - point.y;
    const along = wx * segment.dx + wy * segment.dy;
    const outside = wx * wx + wy * wy - EAT_RADIUS * EAT_RADIUS;

    if (outside <= 0) return segment.start;

    const disc = along * along - outside;
    if (disc < 0) continue;

    const enter = -along - Math.sqrt(disc);
    if (enter >= 0 && enter <= segment.length) return segment.start + enter;
  }

  return null;
}

// Momento (fração do ciclo) em que a boca da cobra chega no quadrado
function eatTime(column, row) {
  const distance = reachDistance(center(column, row));

  if (distance === null) {
    throw new Error(`Quadrado fora do trajeto da cobra (coluna ${column}, linha ${row}).`);
  }

  return (distance / PATH_LENGTH) * MOVE_SHARE;
}

// Faz um traço "deslizar" pelo caminho, sincronizado com a cabeça
const slide = (start) => `
    <animate attributeName="stroke-dashoffset"
      values="${start};${start - PATH_LENGTH};${start - PATH_LENGTH}"
      keyTimes="0;${MOVE_SHARE};1" calcMode="linear"
      dur="${DURATION}s" repeatCount="indefinite"/>`;

/* =========================================================
   QUADRADOS
========================================================= */

const cellsSvg = days
  .map((day) => {
    const level = contributionLevel(day.contributionCount);
    const box = `x="${day.x}" y="${day.y}" width="${CELL}" height="${CELL}" rx="2.5"`;
    const empty = `<rect ${box} class="level-0"/>`;

    if (level === 0) return empty;

    const eat = eatTime(day.column, day.row);
    const gone = Math.min(eat + FADE, REFILL_AT - 0.001);
    const label = day.contributionCount === 1 ? "contribuição" : "contribuições";

    return `${empty}
<rect ${box} class="level-${level}">
  <title>${day.date}: ${day.contributionCount} ${label}</title>
  <animate attributeName="opacity" values="1;1;0;0;1"
    keyTimes="0;${f5(eat)};${f5(gone)};${REFILL_AT};1"
    dur="${DURATION}s" repeatCount="indefinite"/>
</rect>`;
  })
  .join("\n");

/* =========================================================
   CORPO

   Camadas sobrepostas: a primeira cobre o corpo todo (fina, cor
   do rabo); as seguintes cobrem só a parte da frente, cada vez
   mais grossas e claras. Com muitas camadas e pontas arredondadas
   o contorno afina de forma contínua, sem "degraus", até o rabo.
========================================================= */

const bodyLayers = Array.from({ length: LAYERS }, (_, j) => {
  const t = j / (LAYERS - 1);
  return {
    color: snakeGradient(t),
    length: BODY * (1 - 0.86 * t),
    width: BODY_MIN_W + (BODY_MAX_W - BODY_MIN_W) * Math.pow(t, 0.6),
  };
});

const bodySvg = bodyLayers
  .map(
    ({ color, length, width }) => `<path d="${pathD}" fill="none"
  stroke="${color}" stroke-width="${width.toFixed(2)}"
  stroke-linecap="round" stroke-linejoin="round"
  stroke-dasharray="${length.toFixed(2)} ${BIG_GAP}"
  stroke-dashoffset="${length.toFixed(2)}">${slide(length)}
</path>`
  )
  .join("\n");

// Camada visível (a mais grossa) a uma certa distância da cabeça
const layerAt = (distance) =>
  bodyLayers.filter((layer) => layer.length >= distance).at(-1) ?? bodyLayers[0];

/* =========================================================
   ZIGUE-ZAGUE NO DORSO

   Cada traço do zigue-zague é um segmento que segue o trajeto a
   uma distância fixa da cabeça (animateMotion + rotate=auto): o
   desenho acompanha o corpo e gira junto nas curvas.
   A amplitude é sorteada por vértice e limitada pela espessura do
   corpo naquele ponto. A tinta é um violeta escuro opaco que vai
   se misturando à cor do corpo em direção ao rabo.
========================================================= */

const zigCount = Math.floor((ZIG_LEN - ZIG_HEAD_GAP) / ZIG_SPACING);

const zigKnots = Array.from({ length: zigCount + 1 }, (_, j) => {
  const room = layerAt(ZIG_HEAD_GAP + j * ZIG_SPACING).width / 2 - ZIG_WIDTH;
  return (j % 2 ? -1 : 1) * Math.max(0, room) * (0.45 + 0.4 * random());
});

const zigzagSvg = zigKnots
  .slice(0, -1)
  .map((front, i) => {
    const distance = ZIG_HEAD_GAP + (i + 0.5) * ZIG_SPACING;
    const startsAt = (distance / PATH_LENGTH) * MOVE_SHARE;
    const stopsAt = 1 - distance / PATH_LENGTH;
    const half = ZIG_SPACING / 2;
    const ink = mix(ZIG_INK, layerAt(distance).color, 0.5 * (i / Math.max(1, zigCount - 1)));

    return `<path d="M${half} ${front.toFixed(2)} L${-half} ${zigKnots[i + 1].toFixed(2)}"
  stroke="${ink}" stroke-width="${ZIG_WIDTH}" stroke-linecap="round" fill="none">
  <animateMotion dur="${DURATION}s" repeatCount="indefinite" rotate="auto" calcMode="linear"
    keyPoints="0;0;${f5(stopsAt)};${f5(stopsAt)}" keyTimes="0;${f5(startsAt)};${MOVE_SHARE};1">
    <mpath xlink:href="#snake-track"/>
  </animateMotion>
</path>`;
  })
  .join("\n");

/* =========================================================
   CABEÇA

   Formato de víbora: mais larga na mandíbula, afinando até o
   focinho. A cor continua a do pescoço, com brilho radial para
   dar volume, e a marca em V repete o zigue-zague do dorso.
========================================================= */

const headSvg = `
<g>
  <!-- Língua (atrás da cabeça) -->
  <path d="M10 0 H15 M15 0 L17.6 -2.1 M15 0 L17.6 2.1"
        stroke="${TONGUE}" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"
        fill="none" opacity="0">
    <animate attributeName="opacity" values="0;0;1;1;0"
             keyTimes="0;0.5;0.6;0.85;1" dur="1.1s" repeatCount="indefinite"/>
  </path>

  <!-- Cabeça -->
  <path d="M-6 -4.3 C-3.5 -5.4 -1 -6.1 1.5 -6 C5 -5.8 8 -3.9 9.8 -2.2 Q11.4 -0.9 11.4 0
           Q11.4 0.9 9.8 2.2 C8 3.9 5 5.8 1.5 6 C-1 6.1 -3.5 5.4 -6 4.3 Z"
        fill="url(#head-grad)"/>

  <!-- Marca em V -->
  <path d="M-4.6 -2.5 L0.6 0 L-4.6 2.5" stroke="${ZIG_INK}" stroke-width="${ZIG_WIDTH}"
        stroke-linecap="round" stroke-linejoin="round" fill="none"/>

  <!-- Olhos com pupila em fenda -->
  <ellipse cx="3.7" cy="-3.4" rx="1.8" ry="1.45" fill="${EYE}" stroke="${INK}" stroke-width="0.45"/>
  <ellipse cx="3.7" cy="3.4" rx="1.8" ry="1.45" fill="${EYE}" stroke="${INK}" stroke-width="0.45"/>
  <ellipse cx="3.95" cy="-3.4" rx="1.05" ry="0.36" fill="${PUPIL}"/>
  <ellipse cx="3.95" cy="3.4" rx="1.05" ry="0.36" fill="${PUPIL}"/>

  <!-- Narinas -->
  <circle cx="9.3" cy="-0.95" r="0.38" fill="${INK}" opacity="0.55"/>
  <circle cx="9.3" cy="0.95" r="0.38" fill="${INK}" opacity="0.55"/>

  <animateMotion dur="${DURATION}s" repeatCount="indefinite" rotate="auto"
    calcMode="linear" keyPoints="0;1;1" keyTimes="0;${MOVE_SHARE};1">
    <mpath xlink:href="#snake-track"/>
  </animateMotion>
</g>`;

/* =========================================================
   MESES E LEGENDA
========================================================= */

const monthLabels = [];
let prevMonth = -1;
let lastLabelCol = -10;

weeks.forEach((week, column) => {
  const month = Number(week.contributionDays[0].date.slice(5, 7)) - 1;
  if (month !== prevMonth) {
    if (column - lastLabelCol >= 3) {
      monthLabels.push(
        `<text x="${OFFSET_X + column * STEP}" y="${OFFSET_Y - 8}" class="label small">${MONTHS[month]}</text>`
      );
      lastLabelCol = column;
    }
    prevMonth = month;
  }
});

const legendY = OFFSET_Y + GRID_H + 14;
const legendRight = OFFSET_X + GRID_W;
const squaresStart = legendRight - 28 - 5 * STEP + GAP;

const legendSvg = `
<text x="${squaresStart - 5}" y="${legendY + 9}" text-anchor="end" class="label small">Menos</text>
${[0, 1, 2, 3, 4]
  .map(
    (lvl) =>
      `<rect x="${squaresStart + lvl * STEP}" y="${legendY}" width="${CELL}" height="${CELL}" rx="2.5" class="level-${lvl}"/>`
  )
  .join("")}
<text x="${legendRight}" y="${legendY + 9}" text-anchor="end" class="label small">Mais</text>`;

/* =========================================================
   SVG FINAL
========================================================= */

const levelCss = (palette) =>
  palette.map((color, i) => `.level-${i} { fill: ${color}; }`).join("\n    ");

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">

<style>
    ${levelCss(LIGHT)}

    .label {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      font-size: 11px;
      fill: #57606A;
    }
    .small { font-size: 9px; }
    .strong { font-weight: 600; fill: #1F2328; }
    .glow { flood-color: ${SNAKE_TAIL}; flood-opacity: 0.3; }

    @media (prefers-color-scheme: dark) {
    ${levelCss(DARK)}
      .label { fill: #8B949E; }
      .strong { fill: #E6EDF3; }
      .glow { flood-color: #A855F7; flood-opacity: 0.55; }
    }

    /* Movimento reduzido: gráfico parado, sem a cobra */
    @media (prefers-reduced-motion: reduce) {
      #snake { display: none; }
      #contributions rect { opacity: 1 !important; }
    }
</style>

<defs>
  <path id="snake-track" d="${pathD}" fill="none"/>

  <radialGradient id="head-grad" cx="0.45" cy="0.5" r="0.6">
    <stop offset="0" stop-color="${HEAD_CORE}"/>
    <stop offset="0.6" stop-color="${SNAKE_FRONT}"/>
    <stop offset="1" stop-color="${HEAD_EDGE}"/>
  </radialGradient>

  <clipPath id="grid-area">
    <rect x="${OFFSET_X - 7}" y="${OFFSET_Y - 7}" width="${GRID_W + 14}" height="${GRID_H + 14}"/>
  </clipPath>

  <!-- Brilho suave: sombra discreta no tema claro, halo violeta no escuro -->
  <filter id="snake-shadow" x="-10%" y="-10%" width="120%" height="120%">
    <feDropShadow class="glow" dx="0" dy="0.8" stdDeviation="1.6"
                  flood-color="${SNAKE_TAIL}" flood-opacity="0.3"/>
  </filter>
</defs>

<!-- CONTADOR -->
<text x="${OFFSET_X}" y="20" class="label">
  <tspan class="strong">${totalContributions.toLocaleString("pt-BR")}</tspan> contribuições no último ano
</text>

<!-- MESES -->
${monthLabels.join("\n")}

<!-- QUADRADOS -->
<g id="contributions">
${cellsSvg}
</g>

<!-- COBRA -->
<g id="snake" clip-path="url(#grid-area)">
  <g filter="url(#snake-shadow)">
${bodySvg}
${zigzagSvg}
${headSvg}
  </g>
</g>

<!-- LEGENDA -->
${legendSvg}

</svg>
`.trim();

/* =========================================================
   SALVA
========================================================= */

await mkdir("dist", { recursive: true });
await writeFile("dist/github-contribution-snake-custom.svg", svg, "utf8");

console.log(`✓ Snake personalizada criada para @${USERNAME}`);
console.log(`✓ ${totalContributions} contribuições encontradas`);
console.log(`✓ Zigue-zague sorteado com a semente "${SEED}" (ciclo de ${DURATION}s)`);
console.log("✓ dist/github-contribution-snake-custom.svg");