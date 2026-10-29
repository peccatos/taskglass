import { getCurrentWindow } from '@tauri-apps/api/window';
import { LogicalSize, LogicalPosition } from '@tauri-apps/api/dpi';
import { register } from '@tauri-apps/plugin-global-shortcut';
import '@fontsource/inter/600.css';
import '@fontsource/inter/cyrillic-600.css';
import '@fontsource/inter/latin-300.css';
import './style.css';

type Task = {
  id: string;
  title: string;
  completed: boolean;
  createdAt: number;
  completedAt?: number;
};

type PersistedState = { version: 1; tasks: Task[] };

const STORAGE_KEY = 'taskglass.tasks.v1';
const WINDOW_STATE_KEY = 'taskglass.window.v1';
const VISIBLE_TASKS = 5; // 5 карточек задач + 6-я ячейка «Другие задачи»

const initialTasks: Task[] = Array.from({ length: 6 }, (_, index) => ({
  id: `starter-${index + 1}`,
  title: 'Закончить VPN',
  completed: false,
  createdAt: Date.now() - (6 - index) * 60_000,
}));

const taskGrid = document.querySelector<HTMLDivElement>('#taskGrid')!;
const composer = document.querySelector<HTMLFormElement>('#composer')!;
const taskInput = document.querySelector<HTMLInputElement>('#taskInput')!;
const addButton = document.querySelector<HTMLButtonElement>('#addButton')!;
const cancelComposer = document.querySelector<HTMLButtonElement>('#cancelComposer')!;
const completedButton = document.querySelector<HTMLButtonElement>('#completedButton')!;
const emptyState = document.querySelector<HTMLDivElement>('#emptyState')!;
const emptyDescription = document.querySelector<HTMLSpanElement>('#emptyDescription')!;
const clock = document.querySelector<HTMLDivElement>('#clock')!;
const toast = document.querySelector<HTMLDivElement>('#toast')!;
const allTasksOverlay = document.querySelector<HTMLDivElement>('#allTasksOverlay')!;
const allTasksList = document.querySelector<HTMLDivElement>('#allTasksList')!;
const allTasksCount = document.querySelector<HTMLSpanElement>('#allTasksCount')!;

let showingCompleted = false;
let showingAllTasks = false;
let editingId: string | null = null;
let toastTimeout: number | undefined;
let tasks = loadTasks();

// ---------- Drag-and-drop карточек задач ----------
type DragState = {
  card: HTMLElement;
  id: string;
  pointerId: number;
  placeholder: HTMLElement;
  offsetX: number;
  offsetY: number;
  moved: boolean;
};

let dragState: DragState | null = null;

const DRAG_THRESHOLD = 5; // px — движение меньше этого считается кликом, не drag

function taskCardById(id: string): Task | undefined {
  return tasks.find((item) => item.id === id);
}

function initTaskDrag(event: PointerEvent): void {
  if (event.button !== 0) return;
  const card = (event.target as HTMLElement).closest<HTMLElement>('.task-card[data-task-id]');
  if (!card) return;
  // Не стартуем drag с кнопок и полей — там свои клики
  if ((event.target as HTMLElement).closest('button, input, form, .inline-edit')) return;
  const id = card.dataset.taskId!;
  if (!taskCardById(id)) return;

  // Порог: реально начинаем перетаскивание только после движения >5px,
  // чтобы клик по карточке (редактирование) не конфликтовал с drag.
  const startX = event.clientX;
  const startY = event.clientY;
  const onThreshold = (moveEvent: PointerEvent) => {
    if (dragState) return;
    if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < DRAG_THRESHOLD) return;
    card.removeEventListener('pointermove', onThreshold);
    startDrag(card, id, moveEvent);
  };
  card.addEventListener('pointermove', onThreshold);
  const onRelease = () => {
    card.removeEventListener('pointermove', onThreshold);
    card.removeEventListener('pointerup', onRelease);
    card.removeEventListener('pointercancel', onRelease);
  };
  card.addEventListener('pointerup', onRelease);
  card.addEventListener('pointercancel', onRelease);
}

function startDrag(card: HTMLElement, id: string, event: PointerEvent): void {
  const rect = card.getBoundingClientRect();

  const placeholder = document.createElement('div');
  placeholder.className = 'task-card drag-placeholder';
  placeholder.style.height = `${rect.height}px`;
  card.before(placeholder);

  card.classList.add('dragging');
  // Фиксируем размеры: карточка убирается из потока (position: fixed)
  card.style.width = `${rect.width}px`;
  card.style.left = `${rect.left}px`;
  card.style.top = `${rect.top}px`;
  card.setPointerCapture(event.pointerId);

  dragState = {
    card,
    id,
    pointerId: event.pointerId,
    placeholder,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
    moved: true,
  };
  positionDraggedCard(event.clientX, event.clientY);
}

function positionDraggedCard(x: number, y: number): void {
  if (!dragState) return;
  // Карточка position: fixed — координаты от вьюпорта
  dragState.card.style.left = `${x - dragState.offsetX}px`;
  dragState.card.style.top = `${y - dragState.offsetY}px`;
}

function moveTaskDrag(event: PointerEvent): void {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  positionDraggedCard(event.clientX, event.clientY);

  // Карточка под курсором (сама перетаскиваемая — pointer-events: none, не мешает)
  const pointerEl = document.elementFromPoint(event.clientX, event.clientY);
  const overCard = pointerEl?.closest<HTMLElement>('.task-card[data-task-id]');
  const gridCard = overCard && overCard.parentElement === taskGrid ? overCard : null;
  if (gridCard) {
    const overRect = gridCard.getBoundingClientRect();
    const before = event.clientY < overRect.top + overRect.height / 2;
    if (before) dragState.placeholder.before(gridCard);
    else dragState.placeholder.after(gridCard);
  } else if (pointerEl === taskGrid || taskGrid.contains(pointerEl)) {
    // Курсор в свободном месте сетки — оставляем плейсхолдер где был
  }
}

function finishTaskDrag(event: PointerEvent): void {
  if (!dragState) return;
  if (event.pointerId !== dragState.pointerId) return;
  const { card, id, placeholder } = dragState;
  dragState = null;

  // Порядок id из DOM: плейсхолдер стоит на месте, куда бросили карточку
  const orderIds = Array.from(taskGrid.children)
    .map((el) => (el === placeholder ? id : (el as HTMLElement).dataset.taskId))
    .filter((value): value is string => Boolean(value));

  placeholder.remove();
  card.classList.remove('dragging');
  card.style.cssText = '';

  // Переупорядочиваем видимую группу задач по DOM-порядку
  const visibleTasks = tasks.filter((task) => task.completed === showingCompleted);
  const orderMap = new Map(orderIds.map((taskId, index) => [taskId, index]));
  visibleTasks.sort((a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0));
  let insertIndex = tasks.findIndex((task) => task.completed === showingCompleted);
  if (insertIndex === -1) insertIndex = tasks.length;
  tasks = tasks.filter((task) => task.completed !== showingCompleted);
  tasks.splice(insertIndex, 0, ...visibleTasks);
  persist();
  render();
}

taskGrid.addEventListener('pointermove', moveTaskDrag);
taskGrid.addEventListener('pointerup', finishTaskDrag);
taskGrid.addEventListener('pointercancel', finishTaskDrag);
taskGrid.addEventListener('pointerdown', initTaskDrag);

function loadTasks(): Task[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialTasks;
    const parsed = JSON.parse(raw) as PersistedState;
    if (parsed.version !== 1 || !Array.isArray(parsed.tasks)) return initialTasks;
    return parsed.tasks.filter((task) =>
      typeof task.id === 'string' && typeof task.title === 'string' &&
      typeof task.completed === 'boolean' && typeof task.createdAt === 'number'
    );
  } catch {
    return initialTasks;
  }
}

function persist(): void {
  const state: PersistedState = { version: 1, tasks };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    showToast('Не удалось сохранить задачи в локальном хранилище');
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]!);
}

// Material Symbols (wght300) + иконки из макета (Frame 148/149/149-1)
type IconName = 'trash' | 'check' | 'edit' | 'remove' | 'undo' | 'close' | 'expand' | 'checklist' | 'expandSmall' | 'closeSmall' | 'removeSmall' | 'pin';

const ICONS: Record<IconName, string> = {
  trash: '<svg viewBox="0 -960 960 960" aria-hidden="true" fill="currentColor"><path d="M292.31-140q-29.92 0-51.12-21.19Q220-182.39 220-212.31V-720h-40v-60h180v-35.38h240V-780h180v60h-40v507.69Q740-182 719-161q-21 21-51.31 21H292.31ZM680-720H280v507.69q0 5.39 3.46 8.85t8.85 3.46h375.38q4.62 0 8.46-3.85 3.85-3.84 3.85-8.46V-720ZM376.16-280h59.99v-360h-59.99v360Zm147.69 0h59.99v-360h-59.99v360ZM280-720v520-520Z"/></svg>',
  check: '<svg viewBox="0 -960 960 960" aria-hidden="true" fill="currentColor"><path d="M382-253.85 168.62-467.23 211.38-510 382-339.38 748.62-706l42.76 42.77L382-253.85Z"/></svg>',
  edit: '<svg viewBox="0 -960 960 960" aria-hidden="true" fill="currentColor"><path d="M216.16-655.69v-129.23h527.68v129.23H216.16Zm480.76 167.69h94.23q18.77 0 31.58-12.81 12.81-12.81 12.81-31.58 0-18.77-12.81-31.58-12.81-12.81-31.58-12.81h-94.23q-18.77 0-31.58 12.81-12.81 12.81-12.81 31.58 0 18.77 12.81 31.58 12.81 12.81 31.58 12.81ZM216.16-240v-128.85h527.68V-240H216.16Z"/></svg>',
  remove: '<svg viewBox="0 -960 960 960" aria-hidden="true" fill="currentColor"><path d="M220-450v-60h520v60H220Z"/></svg>',
  undo: '<svg viewBox="0 -960 960 960" aria-hidden="true" fill="currentColor"><path d="M480-80q-75 0-140.5-28.5t-114-77q-48.5-48.5-77-114T120-440h60q0 125 87.5 212.5T480-140q20.83 0 41.08-2.77 20.25-2.77 38.92-8.77v63.15q-19.84 5.39-39.77 7.39Q480.31-80 480-80Zm0-140q-56 0-97-30t-57-84h64q13 30 36.5 48t53.5 18q42 0 71-29t29-71q0-42-29-71t-71-29q-17 0-32.5 5.5T418-653h70v60H305q-20-13-32.5-35.69-12.5-22.7-12.5-49.31 0-42 29-71t71-29 71 29 29 71v39h62v-39q0-42 29-71t71-29 29 71-29 71v39h62v-60h-70q-8-10-23.5-15.5T600-640q-42 0-71 29t-29 71q0 30 16.5 52.5T525-453h130v63q-16 54-57 84t-98 30q-17 0-33.5-3t-31.5-9l-1 44q-13 5-27 8t-34 3Z"/></svg>',
  close: '<svg viewBox="0 -960 960 960" aria-hidden="true" fill="currentColor"><path d="M256-213.85 213.85-256l224-224-224-224L256-746.15l224 224 224-224L746.15-704l-224 224 224 224L704-213.85l-224-224-224 224Z"/></svg>',
  expand: '<svg viewBox="0 0 12 12" aria-hidden="true" fill="currentColor"><path d="M1.75 10.25V6.5H2.5V8.97787L8.97787 2.5H6.5V1.75H10.25V5.5H9.5V3.02213L3.02213 9.5H5.5V10.25H1.75Z"/></svg>',
  checklist: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M5.69425 18.4517L2.5 15.2574L3.54425 14.2132L5.66925 16.3382L9.91925 12.0882L10.9635 13.1574L5.69425 18.4517ZM5.69425 10.8362L2.5 7.64191L3.54425 6.59766L5.66925 8.72266L9.91925 4.47266L10.9635 5.54191L5.69425 10.8362ZM13.0095 16.5574V15.0574H21.5095V16.5574H13.0095ZM13.0095 8.94191V7.44191H21.5095V8.94191H13.0095Z"/></svg>',
  expandSmall: '<svg viewBox="0 0 20 20" aria-hidden="true" fill="currentColor"><path d="M5.75 14.25V10.5H6.5V12.9779L12.9779 6.5H10.5V5.75H14.25V9.5H13.5V7.02213L7.02213 13.5H9.5V14.25H5.75Z"/></svg>',
  closeSmall: '<svg viewBox="0 0 20 20" aria-hidden="true" fill="currentColor"><path d="M7.2 13.3266L6.67313 12.7997L9.47313 9.99973L6.67313 7.19973L7.2 6.67285L10 9.47285L12.8 6.67285L13.3269 7.19973L10.5269 9.99973L13.3269 12.7997L12.8 13.3266L10 10.5266L7.2 13.3266Z"/></svg>',
  removeSmall: '<svg viewBox="0 0 20 20" aria-hidden="true" fill="currentColor"><path d="M6.75 10.375V9.625H13.25V10.375H6.75Z"/></svg>',
  pin: '<svg viewBox="0 -960 960 960" aria-hidden="true" fill="currentColor"><path d="M640-800v80h-40v233l160 160v47H520v200h-80v-200H240v-47l160-160v-233h-40v-80h280Z"/></svg>',
};

function icon(name: IconName): string {
  return ICONS[name];
}

function taskCard(task: Task): string {
  const isEditing = editingId === task.id;
  const title = escapeHtml(task.title);
  return `
    <article class="task-card ${task.completed ? 'is-completed' : ''}" data-task-id="${escapeHtml(task.id)}">
      <div class="task-copy">
        <span class="task-label">${task.completed ? 'Выполнено' : 'Задача'}</span>
        ${isEditing
          ? `<form class="inline-edit" data-edit-form="${escapeHtml(task.id)}"><input class="inline-edit-input" aria-label="Изменить задачу" maxlength="120" value="${title}" required /><button class="save-edit" type="submit" aria-label="Сохранить">${icon('check')}</button></form>`
          : `<button class="task-title ${task.completed ? 'completed-title' : ''}" data-action="edit" data-id="${escapeHtml(task.id)}" title="Нажмите, чтобы изменить задачу">${title}</button>`}
      </div>
      <div class="task-actions">
        <button class="icon-button delete-button" data-action="delete" data-id="${escapeHtml(task.id)}" aria-label="Удалить задачу" title="Удалить">${icon('trash')}</button>
        <button class="complete-button" data-action="toggle" data-id="${escapeHtml(task.id)}" aria-label="${task.completed ? 'Вернуть в активные' : 'Отметить выполненной'}" title="${task.completed ? 'Вернуть в активные' : 'Выполнить'}">${icon(task.completed ? 'undo' : 'check')}</button>
      </div>
    </article>`;
}

function moreCard(): string {
  return `
    <button class="task-card more-card" data-action="show-all" title="Открыть полный список задач">
      <span class="task-copy">
        <span class="task-label">Другие задачи</span>
        <span class="more-title">${icon('checklist')}<span>Открыть полный список задач</span></span>
      </span>
    </button>`;
}

function render(): void {
  if (showingAllTasks) {
    renderAllTasks();
    return;
  }
  const visibleTasks = tasks.filter((task) => task.completed === showingCompleted);
  const shownTasks = visibleTasks.slice(0, VISIBLE_TASKS);

  taskGrid.innerHTML = shownTasks.map(taskCard).join('') +
    (visibleTasks.length > VISIBLE_TASKS ? moreCard() : '');

  const isEmpty = visibleTasks.length === 0;
  emptyState.hidden = !isEmpty;
  taskGrid.hidden = isEmpty;
  emptyDescription.textContent = showingCompleted
    ? 'Выполненные задачи появятся здесь.'
    : 'Добавьте первую задачу кнопкой ниже.';
  completedButton.textContent = showingCompleted ? '← К активным задачам' : 'Посмотреть выполненные';
  addButton.textContent = 'Добавить задачу';
  addButton.disabled = showingCompleted;
  addButton.classList.toggle('is-disabled', showingCompleted);
}

function renderAllTasks(): void {
  allTasksOverlay.hidden = false;
  const visibleTasks = tasks.filter((task) => task.completed === showingCompleted);
  allTasksCount.textContent = `Все задачи (${visibleTasks.length})`;
  allTasksList.innerHTML = visibleTasks.map((task) => {
    const title = escapeHtml(task.title);
    return `
      <div class="all-task-row ${task.completed ? 'is-completed' : ''}" data-task-id="${escapeHtml(task.id)}">
        <button class="all-task-toggle" data-action="toggle" data-id="${escapeHtml(task.id)}" aria-label="${task.completed ? 'Вернуть в активные' : 'Отметить выполненной'}">${icon(task.completed ? 'undo' : 'check')}</button>
        <span class="all-task-title ${task.completed ? 'completed-title' : ''}">${title}</span>
        <span class="all-task-meta">${task.completed ? 'выполнено' : 'активная'}</span>
        <button class="icon-button delete-button" data-action="delete" data-id="${escapeHtml(task.id)}" aria-label="Удалить задачу">${icon('trash')}</button>
      </div>`;
  }).join('');
}

function hideAllTasks(): void {
  showingAllTasks = false;
  allTasksOverlay.hidden = true;
  render();
}

function showToast(message: string): void {
  toast.textContent = message;
  toast.classList.add('is-visible');
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => toast.classList.remove('is-visible'), 2300);
}

function openComposer(): void {
  if (showingCompleted) return;
  composer.hidden = false;
  taskInput.focus();
}

function closeComposer(): void {
  composer.hidden = true;
  taskInput.value = '';
}

function addTask(title: string): void {
  const normalized = title.trim();
  if (!normalized) return;
  tasks.unshift({ id: crypto.randomUUID(), title: normalized, completed: false, createdAt: Date.now() });
  persist();
  render();
  closeComposer();
  showToast('Задача добавлена');
}

function toggleTask(id: string): void {
  const task = tasks.find((item) => item.id === id);
  if (!task) return;
  task.completed = !task.completed;
  task.completedAt = task.completed ? Date.now() : undefined;
  persist();
  render();
  showToast(task.completed ? 'Задача выполнена' : 'Задача возвращена в активные');
}

function deleteTask(id: string): void {
  tasks = tasks.filter((task) => task.id !== id);
  if (editingId === id) editingId = null;
  persist();
  render();
  showToast('Задача удалена');
}

// Общий обработчик кликов — работает и в сетке, и в оверлее полного списка
function handleAction(event: Event): void {
  const target = event.target as HTMLElement;
  const button = target.closest<HTMLButtonElement>('button[data-action]');
  if (!button) return;
  const id = button.dataset.id;
  const action = button.dataset.action;
  if (action === 'show-all') {
    showingAllTasks = true;
    editingId = null;
    closeComposer();
    renderAllTasks();
    return;
  }
  if (!id) return;
  if (action === 'delete') deleteTask(id);
  if (action === 'toggle') toggleTask(id);
  if (action === 'edit' && !showingAllTasks) {
    editingId = id;
    render();
    taskGrid.querySelector<HTMLInputElement>('.inline-edit-input')?.focus();
    taskGrid.querySelector<HTMLInputElement>('.inline-edit-input')?.select();
  }
}

taskGrid.addEventListener('click', handleAction);
allTasksList.addEventListener('click', handleAction);

taskGrid.addEventListener('submit', (event) => {
  const form = event.target as HTMLFormElement;
  if (!form.matches('[data-edit-form]')) return;
  event.preventDefault();
  const id = form.dataset.editForm;
  const input = form.querySelector<HTMLInputElement>('input');
  const title = input?.value.trim();
  if (!id || !title) return;
  const task = tasks.find((item) => item.id === id);
  if (task) {
    task.title = title;
    persist();
    showToast('Изменения сохранены');
  }
  editingId = null;
  render();
});

taskGrid.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (editingId) {
    editingId = null;
    render();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && showingAllTasks) {
    hideAllTasks();
  }
});

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  addTask(taskInput.value);
});
addButton.addEventListener('click', openComposer);
cancelComposer.innerHTML = icon('closeSmall');
cancelComposer.addEventListener('click', closeComposer);
completedButton.addEventListener('click', () => {
  showingCompleted = !showingCompleted;
  editingId = null;
  showingAllTasks = false;
  allTasksOverlay.hidden = true;
  closeComposer();
  render();
});

const minimizeButton = document.querySelector<HTMLButtonElement>('#minimizeButton')!;
const closeButton = document.querySelector<HTMLButtonElement>('#closeButton')!;
const closeAllTasks = document.querySelector<HTMLButtonElement>('#closeAllTasks')!;

// Кнопки окна: Frame 149 (минус) — свернуть, Frame 148 (крестик) — закрыть.
minimizeButton.innerHTML = icon('removeSmall');
closeButton.innerHTML = icon('closeSmall');
closeAllTasks.innerHTML = icon('closeSmall');

// «Свернуть» — обычная минимизация окна в панель задач.
const FULL_SIZE = new LogicalSize(614, 282);

minimizeButton.addEventListener('click', () => {
  void getCurrentWindow().minimize();
});
closeButton.addEventListener('click', () => {
  void getCurrentWindow().close();
});
closeAllTasks.addEventListener('click', hideAllTasks);

// Перетаскивание окна. data-tauri-drag-region на шапке не срабатывал:
// в Tauri 2 атрибут работает только когда mousedown попадает прямо в элемент
// с атрибутом, а вложенные (span внутри .date-line) перехватывают событие.
// Поэтому единый обработчик на document: всё окно — зона перетаскивания,
// кроме интерактивных элементов и скроллящихся списков.
function isInteractive(element: HTMLElement): boolean {
  return element.closest(
    'button, input, a, form, textarea, select, .inline-edit, .task-title, .all-tasks-list, .task-grid'
  ) !== null;
}

function startWindowDrag(event: MouseEvent): void {
  if (event.button !== 0) return;
  const target = event.target as HTMLElement;
  if (isInteractive(target)) return;
  void getCurrentWindow().startDragging();
}

document.addEventListener('mousedown', startWindowDrag);

// ---------- Окно: размер, позиция, always-on-top ----------

type WindowState = { x: number; y: number; alwaysOnTop: boolean };

function loadWindowState(): WindowState | null {
  try {
    const raw = localStorage.getItem(WINDOW_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WindowState>;
    if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return null;
    return {
      x: parsed.x,
      y: parsed.y,
      alwaysOnTop: typeof parsed.alwaysOnTop === 'boolean' && parsed.alwaysOnTop,
    };
  } catch {
    return null;
  }
}

function saveWindowState(): void {
  void (async () => {
    try {
      const position = await getCurrentWindow().outerPosition();
      const state: WindowState = {
        x: position.x,
        y: position.y,
        alwaysOnTop: alwaysOnTop,
      };
      localStorage.setItem(WINDOW_STATE_KEY, JSON.stringify(state));
    } catch {
      // позиция недоступна — тихо пропускаем
    }
  })();
}

// Периодически сохраняем позицию (пока окно двигают и после),
// чтобы не привязываться к событиям перемещения.
window.setInterval(saveWindowState, 1000);

// ---------- Always-on-top ----------

let alwaysOnTop = false;

async function setAlwaysOnTop(enabled: boolean): Promise<void> {
  alwaysOnTop = enabled;
  await getCurrentWindow().setAlwaysOnTop(enabled);
  pinButton.classList.toggle('is-active', enabled);
  pinButton.title = enabled ? 'Убрать «поверх всех окон»' : 'Поверх всех окон';
  saveWindowState();
}

// Кнопка-булавка в шапке, рядом с контролами окна
const pinButton = document.createElement('button');
pinButton.className = 'window-control pin-button';
pinButton.innerHTML = icon('pin');
pinButton.setAttribute('aria-label', 'Поверх всех окон');
pinButton.title = 'Поверх всех окон';
pinButton.addEventListener('click', () => {
  void setAlwaysOnTop(!alwaysOnTop);
});
document.querySelector<HTMLElement>('.window-controls')!.prepend(pinButton);

// ---------- Глобальный хоткей Ctrl+Shift+T — показать/скрыть ----------

const TOGGLE_SHORTCUT = 'Ctrl+Shift+T';
let windowHidden = false;

async function toggleWindowVisibility(): Promise<void> {
  if (windowHidden) {
    await getCurrentWindow().show();
    await getCurrentWindow().setFocus();
    windowHidden = false;
  } else {
    await getCurrentWindow().hide();
    windowHidden = true;
  }
}

void register(TOGGLE_SHORTCUT, (event) => {
  if (event.state === 'Pressed') {
    void toggleWindowVisibility();
  }
}).catch((error) => {
  showToast(`Хоткей ${TOGGLE_SHORTCUT} не зарегистрирован: ${String(error)}`);
});

// ---------- Восстановление состояния при старте ----------

void (async () => {
  const state = loadWindowState();
  const win = getCurrentWindow();
  // Форсируем проектный размер (лечит застрявший маленький размер
  // от прошлых ручных ресайзов; окно фиксированное и не ресайзится).
  await win.setSize(FULL_SIZE);
  if (state) {
    // Восстанавливаем позицию, только если она в пределах видимых мониторов
    if (await isPositionOnScreen(state.x, state.y)) {
      await win.setPosition(new LogicalPosition(state.x, state.y));
    }
    if (state.alwaysOnTop) {
      await setAlwaysOnTop(true);
    }
    // Свёрнутое состояние НЕ восстанавливаем: приложение всегда стартует
    // в полном виде, иначе окно рождается «голой» капсулой без контента.
  }
})();

async function isPositionOnScreen(x: number, y: number): Promise<boolean> {
  try {
    const { availableMonitors } = await import('@tauri-apps/api/window');
    const monitors = await availableMonitors();
    return monitors.some((monitor) => {
      const m = monitor.position;
      const s = monitor.size;
      return x >= m.x - 100 && x <= m.x + s.width - 100 &&
             y >= m.y - 30 && y <= m.y + s.height - 60;
    });
  } catch {
    return true; // не смогли проверить — доверяем сохранённому
  }
}

function updateDateTime(): void {
  const now = new Date();
  const weekday = new Intl.DateTimeFormat('ru-RU', { weekday: 'long' }).format(now);
  const date = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }).format(now);
  const time = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  document.querySelector('#weekday')!.textContent = weekday.charAt(0).toLocaleUpperCase('ru-RU') + weekday.slice(1);
  document.querySelector('#date')!.textContent = date;
  clock.textContent = time;
}

updateDateTime();
window.setInterval(updateDateTime, 15_000);
render();
