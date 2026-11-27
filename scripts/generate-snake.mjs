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
const FADE = 0.004;       // tempo que o quadrado leva para sumir
const REFILL_AT = 0.965;  // momento em que os quadrados voltam

// Corpo da cobra
const BODY = 112;         // comprimento em px (~8 quadrados)
const BODY_MAX_W = 9;     // espessura perto da cabeça
const BODY_MIN_W = 2.4;   // espessura na ponta do rabo
const LAYERS = 12;        // camadas do degradê (mais = mais suave)
const ENTRY = BODY + 30;  // px fora do gráfico para entrar e sair

// Paleta roxa
const SNAKE_TAIL = "#2E1065";
const SNAKE_MID = "#7C3AED";
const SNAKE_FRONT = "#C084FC";
const HEAD_LIGHT = "#E9D5FF";
const HEAD_DARK = "#9333EA";
const SCALES = "#F5D0FE";
const EYE = "#FDE047";
const PUPIL = "#1E0B36";
const TONGUE = "#FB7185";
const GLOW = "#7C3AED";

// Escamas (pintas no dorso)
const DOT_SPACING = 7;
const PATTERN_LEN = BODY * 0.7;
const PATTERN_HEAD_GAP = 12;

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
   CAMINHO DA COBRA (entra, percorre em serpente e sai)
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
const BIG_GAP = PATH_LENGTH * 2;

function pathIndex(column, row) {
  return row % 2 === 0 ? row * COLS + column : row * COLS + (COLS - 1 - column);
}

// Momento (fração do ciclo) em que a boca da cobra chega no quadrado
function eatTime(column, row) {
  const distance = ENTRY + pathIndex(column, row) * STEP - 8;
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

   Camadas sobrepostas: a primeira cobre o corpo todo (fina e
   escura), as seguintes cobrem só a parte da frente, cada vez
   mais grossas e claras. As pontas arredondadas fundem tudo
   num corpo contínuo que afina até o rabo.
========================================================= */

const bodySvg = Array.from({ length: LAYERS }, (_, j) => {
  const t = j / (LAYERS - 1);
  const length = BODY * (1 - 0.82 * t);
  const width = BODY_MIN_W + (BODY_MAX_W - BODY_MIN_W) * Math.pow(t, 0.45);

  return `<path d="${pathD}" fill="none"
  stroke="${snakeGradient(t)}" stroke-width="${width.toFixed(2)}"
  stroke-linecap="round" stroke-linejoin="round"
  stroke-dasharray="${length.toFixed(2)} ${BIG_GAP}"
  stroke-dashoffset="${length.toFixed(2)}">${slide(length)}
</path>`;
}).join("\n");

/* =========================================================
   ESCAMAS (pintas claras no dorso)
========================================================= */

const dotsCount = Math.floor((PATTERN_LEN - PATTERN_HEAD_GAP) / DOT_SPACING);
const dotsDash =
  Array(dotsCount).fill(`0.01 ${DOT_SPACING - 0.01}`).join(" ") + ` 0.01 ${BIG_GAP}`;

const scalesSvg = `<path d="${pathD}" fill="none"
  stroke="${SCALES}" stroke-width="2.4" stroke-linecap="round" opacity="0.8"
  stroke-dasharray="${dotsDash}"
  stroke-dashoffset="${PATTERN_LEN.toFixed(2)}">${slide(PATTERN_LEN)}
</path>`;

/* =========================================================
   CABEÇA
========================================================= */

const headSvg = `
<g>
  <!-- Língua (atrás da cabeça) -->
  <path d="M9 0 H14.5 M14.5 0 L17 -2.2 M14.5 0 L17 2.2"
        stroke="${TONGUE}" stroke-width="1.2" stroke-linecap="round" fill="none" opacity="0">
    <animate attributeName="opacity" values="0;0;1;1;0"
             keyTimes="0;0.5;0.6;0.85;1" dur="1.1s" repeatCount="indefinite"/>
  </path>

  <!-- Cabeça -->
  <path d="M-5 -4.6 C-1 -6.6 6 -6.2 9.6 -1.7 Q10.8 0 9.6 1.7 C6 6.2 -1 6.6 -5 4.6 Z"
        fill="url(#head-grad)"/>

  <!-- Olhos com pupila em fenda -->
  <ellipse cx="3.2" cy="-3" rx="1.9" ry="1.6" fill="${EYE}"/>
  <ellipse cx="3.5" cy="-3" rx="0.45" ry="1.25" fill="${PUPIL}"/>
  <ellipse cx="3.2" cy="3" rx="1.9" ry="1.6" fill="${EYE}"/>
  <ellipse cx="3.5" cy="3" rx="0.45" ry="1.25" fill="${PUPIL}"/>

  <!-- Narinas -->
  <circle cx="8.3" cy="-0.9" r="0.4" fill="${PUPIL}" opacity="0.6"/>
  <circle cx="8.3" cy="0.9" r="0.4" fill="${PUPIL}" opacity="0.6"/>

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

    @media (prefers-color-scheme: dark) {
    ${levelCss(DARK)}
      .label { fill: #8B949E; }
      .strong { fill: #E6EDF3; }
    }
</style>

<defs>
  <path id="snake-track" d="${pathD}" fill="none"/>

  <linearGradient id="head-grad" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${HEAD_LIGHT}"/>
    <stop offset="1" stop-color="${HEAD_DARK}"/>
  </linearGradient>

  <clipPath id="grid-area">
    <rect x="${OFFSET_X - 7}" y="${OFFSET_Y - 7}" width="${GRID_W + 14}" height="${GRID_H + 14}"/>
  </clipPath>

  <filter id="snake-shadow" x="-10%" y="-10%" width="120%" height="120%">
    <feDropShadow dx="0" dy="1.2" stdDeviation="1.4" flood-color="${GLOW}" flood-opacity="0.55"/>
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
${scalesSvg}
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