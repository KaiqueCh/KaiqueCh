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

// Grade
const CELL = 10;
const GAP = 4;
const STEP = CELL + GAP;
const OFFSET_X = 28;
const OFFSET_Y = 46;

// Tempo
const DURATION = 24;      // ciclo completo, em segundos
const MOVE_SHARE = 0.9;   // fração do ciclo com a cobra andando (o resto é pausa)
const FADE = 0.004;       // tempo que o quadrado leva para sumir (fração do ciclo)
const REFILL_AT = 0.965;  // momento em que os quadrados voltam

// Cobra
const SNAKE_HEAD = "#2EE6A6";
const SNAKE_TAIL = "#0B7A5C";
const TONGUE = "#FF4D78";
const BODY_SEGMENTS = 28;
const SEGMENT_SPACING = 3; // px entre segmentos (menor = corpo mais liso)
const BODY_MAX_R = 5.2;
const BODY_MIN_R = 2;
const ENTRY = 120;         // px fora do gráfico para entrar e sair

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

const f5 = (n) => n.toFixed(5);

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
   ORGANIZA OS DIAS
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

/* =========================================================
   DEFINE NÍVEIS DOS QUADRADOS
========================================================= */

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
   CAMINHO DA COBRA

   Entra pela esquerda, percorre em serpente e sai:

   ⟶ → → → → →
               ↓
     ← ← ← ← ←
     ↓
     → → → → → ⟶
========================================================= */

const center = (column, row) => ({
  x: OFFSET_X + column * STEP + CELL / 2,
  y: OFFSET_Y + row * STEP + CELL / 2,
});

const gridPoints = [];

for (let row = 0; row < ROWS; row++) {
  for (let i = 0; i < COLS; i++) {
    const column = row % 2 === 0 ? i : COLS - 1 - i;
    gridPoints.push(center(column, row));
  }
}

const first = gridPoints[0];
const last = gridPoints[gridPoints.length - 1];
const exitDir = (ROWS - 1) % 2 === 0 ? 1 : -1;

const trackPoints = [
  { x: first.x - ENTRY, y: first.y },
  ...gridPoints,
  { x: last.x + exitDir * ENTRY, y: last.y },
];

const pathD = trackPoints.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ");

const PATH_LENGTH = ENTRY * 2 + (gridPoints.length - 1) * STEP;
const SPEED = PATH_LENGTH / (DURATION * MOVE_SHARE); // px por segundo
const SEGMENT_DELAY = SEGMENT_SPACING / SPEED;
const LEAD = BODY_SEGMENTS * SEGMENT_DELAY;           // todos já começam em movimento

function pathIndex(column, row) {
  return row % 2 === 0 ? row * COLS + column : row * COLS + (COLS - 1 - column);
}

// Momento (fração do ciclo) em que a cabeça chega no quadrado
function eatTime(column, row) {
  const distance = ENTRY + pathIndex(column, row) * STEP - 4;
  return (distance / PATH_LENGTH) * MOVE_SHARE;
}

const motion = (begin) => `
    <animateMotion
      dur="${DURATION}s"
      begin="${begin.toFixed(3)}s"
      repeatCount="indefinite"
      rotate="auto"
      calcMode="linear"
      keyPoints="0;1;1"
      keyTimes="0;${MOVE_SHARE};1"
    ><mpath xlink:href="#snake-track"/></animateMotion>`;

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
    dur="${DURATION}s" begin="${(-LEAD).toFixed(3)}s" repeatCount="indefinite"/>
</rect>`;
  })
  .join("\n");

/* =========================================================
   CORPO (cauda desenhada primeiro, cabeça por cima)
========================================================= */

const bodySvg = Array.from({ length: BODY_SEGMENTS }, (_, i) => {
  const k = BODY_SEGMENTS - i;
  const t = (k - 1) / (BODY_SEGMENTS - 1);
  const r = BODY_MAX_R - t * (BODY_MAX_R - BODY_MIN_R);

  return `<circle r="${r.toFixed(2)}" fill="${mix(SNAKE_HEAD, SNAKE_TAIL, t)}">${motion(
    -LEAD + k * SEGMENT_DELAY
  )}
</circle>`;
}).join("\n");

/* =========================================================
   CABEÇA
========================================================= */

const headSvg = `
<g>
  <ellipse cx="1" cy="0" rx="7.2" ry="6" fill="${SNAKE_HEAD}"/>

  <!-- Olhos -->
  <circle cx="3" cy="-2.8" r="1.9" fill="#FFFFFF"/>
  <circle cx="3.8" cy="-2.8" r="0.9" fill="#07130F"/>
  <circle cx="3" cy="2.8" r="1.9" fill="#FFFFFF"/>
  <circle cx="3.8" cy="2.8" r="0.9" fill="#07130F"/>

  <!-- Língua -->
  <path d="M7.5 0 H12.5 M12.5 0 L15 -2 M12.5 0 L15 2"
        stroke="${TONGUE}" stroke-width="1.3" stroke-linecap="round" fill="none" opacity="0">
    <animate attributeName="opacity" values="0;0;1;1;0"
             keyTimes="0;0.5;0.6;0.85;1" dur="1.1s" repeatCount="indefinite"/>
  </path>
  ${motion(-LEAD)}
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

    @media (prefers-color-scheme: dark) {
    ${levelCss(DARK)}
      .label { fill: #8B949E; }
      .strong { fill: #E6EDF3; }
    }
</style>

<defs>
  <path id="snake-track" d="${pathD}" fill="none"/>

  <clipPath id="grid-area">
    <rect x="${OFFSET_X - 5}" y="${OFFSET_Y - 5}" width="${GRID_W + 10}" height="${GRID_H + 10}"/>
  </clipPath>

  <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
    <feGaussianBlur stdDeviation="1.8" result="blur"/>
    <feMerge>
      <feMergeNode in="blur"/>
      <feMergeNode in="SourceGraphic"/>
    </feMerge>
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
  <g filter="url(#glow)">
${bodySvg}
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
console.log("✓ dist/github-contribution-snake-custom.svg");