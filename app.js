const STORAGE_KEY = "carry.todo.v1";
const DAY_MS = 24 * 60 * 60 * 1000;

const defaultState = {
  tasks: [],
  archivedDays: {},
  lastOpenedDate: todayKey(),
  settings: {},
};

let state = loadState();
let activeView = "today";
let draggedId = null;

const els = {};

document.addEventListener("DOMContentLoaded", () => {
  cacheElements();
  migrateDayIfNeeded();
  bindEvents();
  render();
  registerServiceWorker();
});

function cacheElements() {
  els.dateLabel = document.querySelector("#dateLabel");
  els.taskList = document.querySelector("#taskList");
  els.emptyState = document.querySelector("#emptyState");
  els.historyList = document.querySelector("#historyList");
  els.taskForm = document.querySelector("#taskForm");
  els.taskInput = document.querySelector("#taskInput");
  els.sortButton = document.querySelector("#sortButton");
  els.tabButtons = Array.from(document.querySelectorAll(".tab-button"));
  els.views = {
    today: document.querySelector("#todayView"),
    history: document.querySelector("#historyView"),
  };
}

function bindEvents() {
  els.taskForm.addEventListener("submit", (event) => {
    event.preventDefault();
    addTask(els.taskInput.value);
  });

  els.sortButton.addEventListener("click", () => {
    sortTodayTasks({ respectManualOrder: false });
    saveAndRender();
  });

  els.tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      activeView = button.dataset.view;
      render();
    });
  });
}

function loadState() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return structuredClone(defaultState);
    const parsed = JSON.parse(stored);
    return {
      ...structuredClone(defaultState),
      ...parsed,
      settings: { ...defaultState.settings, ...(parsed.settings || {}) },
      archivedDays: parsed.archivedDays || {},
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    };
  } catch {
    return structuredClone(defaultState);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function saveAndRender() {
  saveState();
  render();
}

function todayKey(date = new Date()) {
  const local = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return local.toISOString().slice(0, 10);
}

function formatDay(dayKey) {
  const [year, month, day] = dayKey.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(date);
}

function migrateDayIfNeeded() {
  const currentDay = todayKey();
  if (!state.lastOpenedDate) state.lastOpenedDate = currentDay;
  if (state.lastOpenedDate === currentDay) {
    saveState();
    return;
  }

  archiveOpenDay(state.lastOpenedDate);
  state.tasks = state.tasks
    .filter((task) => !task.completed)
    .map((task, index) => ({
      ...task,
      activeDate: currentDay,
      order: index,
      manuallyOrdered: false,
    }));
  state.lastOpenedDate = currentDay;
  saveState();
}

function archiveOpenDay(dayKey) {
  const snapshot = state.tasks.map((task) => ({
    id: task.id,
    text: task.text,
    completed: task.completed,
    completedAt: task.completedAt || null,
    order: task.order || 0,
  }));

  if (snapshot.length) {
    state.archivedDays[dayKey] = snapshot;
  }
}

function addTask(rawText) {
  const text = rawText.trim();
  if (!text) return;

  const task = {
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    text,
    createdAt: new Date().toISOString(),
    activeDate: todayKey(),
    completed: false,
    completedAt: null,
    order: nextOrder(),
    manuallyOrdered: false,
  };

  state.tasks.push(task);
  insertBySimilarity(task.id);
  els.taskInput.value = "";
  saveAndRender();
}

function nextOrder() {
  return state.tasks.reduce((max, task) => Math.max(max, Number(task.order) || 0), -1) + 1;
}

function toggleTask(id) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) return;
  task.completed = !task.completed;
  task.completedAt = task.completed ? new Date().toISOString() : null;
  saveAndRender();
}

function editTask(id) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) return;
  const next = prompt("Edit task", task.text);
  if (next === null) return;
  const trimmed = next.trim();
  if (!trimmed) {
    deleteTask(id);
    return;
  }
  task.text = trimmed;
  saveAndRender();
}

function deleteTask(id) {
  state.tasks = state.tasks.filter((task) => task.id !== id);
  normalizeOrder();
  saveAndRender();
}

function render() {
  els.dateLabel.textContent = formatDay(todayKey());
  renderTabs();
  renderToday();
  renderHistory();
}

function renderTabs() {
  els.tabButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.view === activeView);
  });
  Object.entries(els.views).forEach(([name, view]) => {
    view.classList.toggle("active", name === activeView);
  });
}

function renderToday() {
  const tasks = orderedTasks();
  els.emptyState.hidden = tasks.length > 0;
  els.taskList.innerHTML = "";

  tasks.forEach((task) => {
    const item = document.createElement("li");
    item.className = `task-item${task.completed ? " completed" : ""}`;
    item.draggable = true;
    item.dataset.id = task.id;

    const check = document.createElement("button");
    check.className = "check-button";
    check.type = "button";
    check.setAttribute("aria-label", task.completed ? "Mark task incomplete" : "Mark task complete");
    check.textContent = "✓";
    check.addEventListener("click", () => toggleTask(task.id));

    const text = document.createElement("button");
    text.className = "task-text";
    text.type = "button";
    text.textContent = task.text;
    text.addEventListener("click", () => editTask(task.id));
    text.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      deleteTask(task.id);
    });

    const handle = document.createElement("button");
    handle.className = "drag-handle";
    handle.type = "button";
    handle.setAttribute("aria-label", "Drag to reorder");
    handle.textContent = "☰";

    const remove = document.createElement("button");
    remove.className = "delete-button";
    remove.type = "button";
    remove.setAttribute("aria-label", "Delete task");
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      if (confirm("Delete this task?")) deleteTask(task.id);
    });

    item.addEventListener("dragstart", () => {
      draggedId = task.id;
      item.classList.add("dragging");
    });
    item.addEventListener("dragend", () => {
      draggedId = null;
      item.classList.remove("dragging");
    });
    item.addEventListener("dragover", (event) => event.preventDefault());
    item.addEventListener("drop", (event) => {
      event.preventDefault();
      reorderByDrop(draggedId, task.id);
    });

    item.append(check, text, handle, remove);
    els.taskList.append(item);
  });
}

function renderHistory() {
  const days = Object.keys(state.archivedDays).sort().reverse();
  els.historyList.innerHTML = "";

  if (!days.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = "<h2>No history yet</h2><p>Finished days will show up here after rollover.</p>";
    els.historyList.append(empty);
    return;
  }

  days.forEach((day) => {
    const section = document.createElement("section");
    section.className = "history-day";
    const title = document.createElement("h2");
    title.textContent = formatDay(day);
    const list = document.createElement("ul");

    [...state.archivedDays[day]]
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .forEach((task) => {
        const row = document.createElement("li");
        row.className = "history-task";
        const mark = document.createElement("span");
        mark.textContent = task.completed ? "✓" : "○";
        const label = document.createElement("span");
        if (task.completed) {
          label.innerHTML = `<strong>${escapeHtml(task.text)}</strong>`;
        } else {
          label.textContent = task.text;
        }
        row.append(mark, label);
        list.append(row);
      });

    section.append(title, list);
    els.historyList.append(section);
  });
}

function orderedTasks() {
  return [...state.tasks].sort((a, b) => {
    if (a.completed !== b.completed) return Number(a.completed) - Number(b.completed);
    return (Number(a.order) || 0) - (Number(b.order) || 0);
  });
}

function normalizeOrder(tasks = orderedTasks()) {
  tasks.forEach((task, index) => {
    task.order = index;
  });
}

function reorderByDrop(sourceId, targetId) {
  if (!sourceId || sourceId === targetId) return;
  const tasks = orderedTasks();
  const from = tasks.findIndex((task) => task.id === sourceId);
  const to = tasks.findIndex((task) => task.id === targetId);
  if (from < 0 || to < 0) return;
  const [moved] = tasks.splice(from, 1);
  tasks.splice(to, 0, moved);
  tasks.forEach((task, index) => {
    task.order = index;
    task.manuallyOrdered = true;
  });
  saveAndRender();
}

function insertBySimilarity(taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;

  const candidates = state.tasks.filter((item) => item.id !== taskId && !item.completed);
  if (!candidates.length) {
    normalizeOrder();
    return;
  }

  let best = null;
  for (const candidate of candidates) {
    const score = similarity(task.text, candidate.text);
    if (!best || score > best.score) best = { task: candidate, score };
  }

  const sorted = orderedTasks().filter((item) => item.id !== taskId);
  const insertIndex = best && best.score > 0.08 ? sorted.findIndex((item) => item.id === best.task.id) + 1 : sorted.length;
  sorted.splice(Math.max(0, insertIndex), 0, task);
  normalizeOrder(sorted);
}

function sortTodayTasks({ respectManualOrder }) {
  const completed = state.tasks.filter((task) => task.completed);
  const open = state.tasks.filter((task) => !task.completed);
  if (respectManualOrder && open.some((task) => task.manuallyOrdered)) return;
  const clustered = [];

  open.forEach((task) => {
    if (!clustered.length) {
      clustered.push(task);
      return;
    }

    let bestIndex = -1;
    let bestScore = 0;
    clustered.forEach((candidate, index) => {
      const score = similarity(task.text, candidate.text);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });

    if (bestScore > 0.08) clustered.splice(bestIndex + 1, 0, task);
    else clustered.push(task);
  });

  [...clustered, ...completed].forEach((task, index) => {
    task.order = index;
    task.manuallyOrdered = false;
  });
}

function similarity(a, b) {
  const tokensA = expandTokens(tokenize(a));
  const tokensB = expandTokens(tokenize(b));
  const tokenScore = jaccard(tokensA, tokensB);
  const gramScore = jaccard(ngrams(normalize(a), 3), ngrams(normalize(b), 3));
  return tokenScore * 0.72 + gramScore * 0.28;
}

function normalize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenize(text) {
  return normalize(text)
    .split(" ")
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function expandTokens(tokens) {
  const expanded = new Set(tokens);
  tokens.forEach((token) => {
    const root = SYNONYMS[token];
    if (root) expanded.add(root);
  });
  return expanded;
}

function ngrams(text, size) {
  const compact = text.replace(/\s/g, "");
  const grams = new Set();
  for (let index = 0; index <= compact.length - size; index += 1) {
    grams.add(compact.slice(index, index + size));
  }
  if (!grams.size && compact) grams.add(compact);
  return grams;
}

function jaccard(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  setA.forEach((value) => {
    if (setB.has(value)) intersection += 1;
  });
  return intersection / (setA.size + setB.size - intersection);
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => (
    {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    }[char]
  ));
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "about",
  "into",
  "from",
  "this",
  "that",
  "more",
  "some",
  "task",
  "todo",
]);

const SYNONYMS = {
  buy: "purchase",
  order: "purchase",
  get: "purchase",
  pickup: "purchase",
  groceries: "food",
  grocery: "food",
  popcorn: "food",
  onion: "food",
  jalepeno: "food",
  jalapeno: "food",
  clean: "home",
  tidy: "home",
  laundry: "home",
  clothes: "home",
  bathroom: "home",
  living: "home",
  email: "message",
  call: "message",
  text: "message",
  contact: "message",
  setup: "tech",
  nas: "tech",
  ios: "tech",
  app: "tech",
  model: "tech",
  camera: "gear",
  tires: "gear",
  charger: "gear",
  climbing: "gear",
};
