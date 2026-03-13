const ALL_FILTER = "__ALL__";
const EDIT_KEY_STORE = "travel_edit_keys_v1";
const FEATURE_BAR_COLLAPSED_STORE = "feature_bar_collapsed_v1";

const state = {
  authors: [],
  albums: [],
  regions: [],
  rawEntries: [],
  entries: [],
  activeAuthor: ALL_FILTER,
  activeAlbum: ALL_FILTER,
  activeRegion: ALL_FILTER,
  selectedEntry: null,
  revealObserver: null
};

const appShellEl = document.querySelector("#appShell");
const featureBarToggleBtnEl = document.querySelector("#featureBarToggleBtn");
const authorChipsEl = document.querySelector("#authorChips");
const albumListEl = document.querySelector("#albumList");
const regionChipsEl = document.querySelector("#regionChips");
const heroMetaEl = document.querySelector("#heroMeta");
const timelineGridEl = document.querySelector("#timelineGrid");
const openUploadBtnEl = document.querySelector("#openUploadBtn");
const uploadModalEl = document.querySelector("#uploadModal");
const entryModalEl = document.querySelector("#entryModal");
const uploadFormEl = document.querySelector("#uploadForm");
const editFormEl = document.querySelector("#editForm");
const commentFormEl = document.querySelector("#commentForm");
const commentListEl = document.querySelector("#commentList");
const detailImageEl = document.querySelector("#detailImage");
const detailMetaEl = document.querySelector("#detailMeta");
const detailNoteEl = document.querySelector("#detailNote");
const entryModalTitleEl = document.querySelector("#entryModalTitle");
const toastEl = document.querySelector("#toast");

const dateFormatter = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" });
let cachedEditKeys = loadEditKeys();
let featureBarToggleTimer = null;

init().catch((error) => {
  console.error(error);
  showToast(error.message || "初始化失败");
});

function init() {
  applyFeatureBarState(loadFeatureBarCollapsed());
  bindGlobalEvents();
  return refreshData();
}

function bindGlobalEvents() {
  featureBarToggleBtnEl.addEventListener("click", () => {
    appShellEl.classList.add("featurebar-toggling");
    clearTimeout(featureBarToggleTimer);

    const isCollapsed = !appShellEl.classList.contains("featurebar-collapsed");
    applyFeatureBarState(isCollapsed);
    saveFeatureBarCollapsed(isCollapsed);

    featureBarToggleTimer = setTimeout(() => {
      appShellEl.classList.remove("featurebar-toggling");
    }, 320);
  });

  openUploadBtnEl.addEventListener("click", () => openModal(uploadModalEl));

  document.querySelectorAll("[data-close]").forEach((button) => {
    button.addEventListener("click", () => {
      closeModal(document.getElementById(button.dataset.close));
    });
  });

  [uploadModalEl, entryModalEl].forEach((modalEl) => {
    modalEl.addEventListener("click", (event) => {
      if (event.target === modalEl) {
        closeModal(modalEl);
      }
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeModal(uploadModalEl);
      closeModal(entryModalEl);
    }
  });

  uploadFormEl.addEventListener("submit", submitUploadForm);
  editFormEl.addEventListener("submit", submitEditForm);
  commentFormEl.addEventListener("submit", submitCommentForm);
  timelineGridEl.addEventListener("click", handleTimelineClick);
}

async function refreshData() {
  await loadAuthors();
  syncActiveAuthor();
  await loadAlbums();
  syncActiveAlbum();
  await loadEntries();
  syncActiveRegion();
  applyRegionFilter();
  renderRegions();
  renderHeroMeta();
  renderTimeline();
}

function syncActiveAuthor() {
  const names = state.authors.map((item) => item.author);
  if (state.activeAuthor !== ALL_FILTER && !names.includes(state.activeAuthor)) {
    state.activeAuthor = ALL_FILTER;
  }
}

function syncActiveAlbum() {
  const names = state.albums.map((item) => item.album);
  if (state.activeAlbum !== ALL_FILTER && !names.includes(state.activeAlbum)) {
    state.activeAlbum = ALL_FILTER;
  }
}

function syncActiveRegion() {
  const names = state.regions.map((item) => item.region);
  if (state.activeRegion !== ALL_FILTER && !names.includes(state.activeRegion)) {
    state.activeRegion = ALL_FILTER;
  }
}

async function loadAuthors() {
  state.authors = await fetchJSON("/api/authors");
  renderAuthors();
}

async function loadAlbums() {
  const query = new URLSearchParams();
  if (state.activeAuthor !== ALL_FILTER) {
    query.set("author", state.activeAuthor);
  }
  state.albums = await fetchJSON(`/api/albums?${query.toString()}`);
  renderAlbums();
}

async function loadEntries() {
  const query = new URLSearchParams();
  if (state.activeAuthor !== ALL_FILTER) {
    query.set("author", state.activeAuthor);
  }
  if (state.activeAlbum !== ALL_FILTER) {
    query.set("album", state.activeAlbum);
  }
  state.rawEntries = await fetchJSON(`/api/entries?${query.toString()}`);
  state.regions = buildRegionStats(state.rawEntries);
}

function renderAuthors() {
  const total = state.authors.reduce((sum, item) => sum + item.count, 0);
  const items = [{ author: ALL_FILTER, count: total }, ...state.authors];

  authorChipsEl.innerHTML = items
    .map((item) => {
      const activeClass = item.author === state.activeAuthor ? "active" : "";
      const label = item.author === ALL_FILTER ? "全部" : item.author;
      return `<button class="chip ${activeClass}" data-author="${escapeAttr(item.author)}">${escapeHtml(label)} · ${item.count}</button>`;
    })
    .join("");

  authorChipsEl.querySelectorAll(".chip").forEach((button) => {
    button.addEventListener("click", async () => {
      state.activeAuthor = button.dataset.author;
      state.activeAlbum = ALL_FILTER;
      state.activeRegion = ALL_FILTER;
      await refreshData();
    });
  });
}

function renderAlbums() {
  const total = state.albums.reduce((sum, item) => sum + item.count, 0);
  const items = [{ album: ALL_FILTER, count: total }, ...state.albums];

  albumListEl.innerHTML = items
    .map((item) => {
      const activeClass = item.album === state.activeAlbum ? "active" : "";
      const label = item.album === ALL_FILTER ? "全部" : item.album;
      return `<button class="album-btn ${activeClass}" data-album="${escapeAttr(item.album)}">${escapeHtml(label)} · ${item.count}</button>`;
    })
    .join("");

  albumListEl.querySelectorAll(".album-btn").forEach((button) => {
    button.addEventListener("click", async () => {
      state.activeAlbum = button.dataset.album;
      state.activeRegion = ALL_FILTER;
      renderAlbums();
      await loadEntries();
      syncActiveRegion();
      applyRegionFilter();
      renderRegions();
      renderHeroMeta();
      renderTimeline();
    });
  });
}

function renderRegions() {
  const total = state.regions.reduce((sum, item) => sum + item.count, 0);
  const items = [{ region: ALL_FILTER, count: total }, ...state.regions];

  regionChipsEl.innerHTML = items
    .map((item) => {
      const activeClass = item.region === state.activeRegion ? "active" : "";
      const label = item.region === ALL_FILTER ? "\u5168\u90e8" : item.region;
      return `<button class="chip ${activeClass}" data-region="${escapeAttr(item.region)}">${escapeHtml(label)} \u00b7 ${item.count}</button>`;
    })
    .join("");

  regionChipsEl.querySelectorAll(".chip").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeRegion = button.dataset.region;
      applyRegionFilter();
      renderRegions();
      renderHeroMeta();
      renderTimeline();
    });
  });
}

function applyRegionFilter() {
  if (state.activeRegion === ALL_FILTER) {
    state.entries = state.rawEntries.slice();
    return;
  }
  state.entries = state.rawEntries.filter((entry) => {
    const regionInfo = extractRegionInfo(entry.location);
    return regionInfo.region === state.activeRegion;
  });
}

function renderHeroMeta() {
  const fragments = [`\u5171 ${state.entries.length} \u6761\u8bb0\u5f55`];
  if (state.activeAuthor !== ALL_FILTER) {
    fragments.push(`\u4f5c\u8005\uff1a${state.activeAuthor}`);
  }
  if (state.activeAlbum !== ALL_FILTER) {
    fragments.push(`\u76f8\u518c\uff1a${state.activeAlbum}`);
  }
  if (state.activeRegion !== ALL_FILTER) {
    fragments.push(`\u5730\u533a\uff1a${state.activeRegion}`);
  }
  heroMetaEl.textContent = fragments.join(" | ");
}

function renderTimeline() {
  if (!state.entries.length) {
    timelineGridEl.innerHTML = '<p class="empty">当前筛选条件下暂无记录，试试切换作者或相册。</p>';
    return;
  }

  timelineGridEl.innerHTML = state.entries
    .map((entry, index) => {
      const wideClass = entry.imageRatio >= 1.35 ? "wide" : "";
      return `
        <article class="entry-card ${wideClass}" data-id="${entry.id}" style="--delay: ${index * 50}ms">
          <div class="image-wrap">
            <img src="${escapeAttr(entry.imagePath)}" alt="${escapeAttr(entry.title)}" loading="lazy">
            <div class="card-badges">
              <span class="badge">${escapeHtml(entry.author)}</span>
              <span class="badge">${escapeHtml(entry.album)}</span>
            </div>
          </div>
          <div class="entry-note">
            <div class="entry-head">
              <h3 class="entry-title">${escapeHtml(entry.title)}</h3>
              <time class="entry-date">${formatDate(entry.travelDate)}</time>
            </div>
            <p class="entry-meta">${escapeHtml(entry.location)} · 评论 ${entry.commentCount}</p>
            <p class="entry-text">${escapeHtml(entry.note)}</p>
          </div>
        </article>
      `;
    })
    .join("");

  runRevealAnimation();
}

function runRevealAnimation() {
  if (state.revealObserver) {
    state.revealObserver.disconnect();
  }
  state.revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("show");
          state.revealObserver.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.16 }
  );

  timelineGridEl.querySelectorAll(".entry-card").forEach((card) => state.revealObserver.observe(card));
}

function handleTimelineClick(event) {
  const card = event.target.closest(".entry-card");
  if (!card) {
    return;
  }
  const id = Number(card.dataset.id);
  openEntryModal(id).catch((error) => {
    console.error(error);
    showToast(error.message || "打开详情失败");
  });
}

async function openEntryModal(id) {
  const entry = state.entries.find((item) => item.id === id);
  if (!entry) {
    throw new Error("记录不存在");
  }

  state.selectedEntry = entry;
  detailImageEl.src = entry.imagePath;
  detailImageEl.alt = entry.title;
  detailMetaEl.textContent = `${entry.author} · ${entry.album} · ${entry.location} · ${formatDate(entry.travelDate)}`;
  detailNoteEl.textContent = entry.note;
  entryModalTitleEl.textContent = entry.title;

  editFormEl.author.value = entry.author;
  editFormEl.album.value = entry.album;
  editFormEl.title.value = entry.title;
  editFormEl.location.value = entry.location;
  editFormEl.travelDate.value = entry.travelDate;
  editFormEl.note.value = entry.note;
  editFormEl.currentEditKey.value = cachedEditKeys[String(entry.id)] || "";
  editFormEl.nextEditKey.value = "";

  commentFormEl.reset();
  await loadComments(entry.id);
  openModal(entryModalEl);
}

async function loadComments(entryId) {
  const comments = await fetchJSON(`/api/entries/${entryId}/comments`);
  if (!comments.length) {
    commentListEl.innerHTML = '<li class="comment-item"><p>还没有评论，成为第一个留言的人。</p></li>';
    return;
  }
  commentListEl.innerHTML = comments
    .map(
      (comment) => `
        <li class="comment-item">
          <div class="comment-top">
            <strong>${escapeHtml(comment.commenter)}</strong>
            <time>${formatDateTime(comment.createdAt)}</time>
          </div>
          <p>${escapeHtml(comment.content)}</p>
        </li>
      `
    )
    .join("");
}

async function submitUploadForm(event) {
  event.preventDefault();
  const submitButton = uploadFormEl.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = "发布中...";

  try {
    const formData = new FormData(uploadFormEl);
    const editKey = String(formData.get("editKey") || "");
    const created = await fetchJSON("/api/entries", { method: "POST", body: formData });

    rememberEditKey(created.id, editKey);
    showToast("发布成功，已加入时间线。");
    uploadFormEl.reset();
    closeModal(uploadModalEl);
    await refreshData();
  } catch (error) {
    showToast(error.message || "发布失败");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "发布";
  }
}

async function submitEditForm(event) {
  event.preventDefault();
  if (!state.selectedEntry) {
    return;
  }

  const submitButton = editFormEl.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = "保存中...";

  const payload = {
    author: editFormEl.author.value.trim(),
    album: editFormEl.album.value.trim(),
    title: editFormEl.title.value.trim(),
    location: editFormEl.location.value.trim(),
    travelDate: editFormEl.travelDate.value,
    note: editFormEl.note.value.trim(),
    currentEditKey: editFormEl.currentEditKey.value.trim()
  };

  const nextEditKey = editFormEl.nextEditKey.value.trim();
  if (nextEditKey) {
    payload.nextEditKey = nextEditKey;
  }

  try {
    const updated = await fetchJSON(`/api/entries/${state.selectedEntry.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    rememberEditKey(updated.id, nextEditKey || payload.currentEditKey);
    showToast("记录已更新。");
    state.selectedEntry = updated;
    await refreshData();
    await openEntryModal(updated.id);
  } catch (error) {
    showToast(error.message || "保存失败");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "保存修改";
  }
}

async function submitCommentForm(event) {
  event.preventDefault();
  if (!state.selectedEntry) {
    return;
  }

  const submitButton = commentFormEl.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = "提交中...";

  const payload = {
    commenter: commentFormEl.commenter.value.trim(),
    content: commentFormEl.content.value.trim()
  };

  try {
    await fetchJSON(`/api/entries/${state.selectedEntry.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    commentFormEl.reset();
    showToast("评论已发布。");
    await loadComments(state.selectedEntry.id);
    await loadEntries();
    syncActiveRegion();
    applyRegionFilter();
    renderRegions();
    renderHeroMeta();
    renderTimeline();
  } catch (error) {
    showToast(error.message || "评论失败");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "发表评论";
  }
}

function openModal(modalEl) {
  modalEl.classList.add("open");
  modalEl.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeModal(modalEl) {
  modalEl.classList.remove("open");
  modalEl.setAttribute("aria-hidden", "true");
  if (!document.querySelector(".modal.open")) {
    document.body.style.overflow = "";
  }
}

function applyFeatureBarState(isCollapsed) {
  appShellEl.classList.toggle("featurebar-collapsed", isCollapsed);
  featureBarToggleBtnEl.setAttribute("aria-expanded", String(!isCollapsed));
  featureBarToggleBtnEl.textContent = isCollapsed ? "\u5c55\u5f00\u529f\u80fd\u680f" : "\u6536\u8d77\u529f\u80fd\u680f";
}

function loadFeatureBarCollapsed() {
  try {
    return localStorage.getItem(FEATURE_BAR_COLLAPSED_STORE) === "1";
  } catch (_error) {
    return false;
  }
}

function saveFeatureBarCollapsed(isCollapsed) {
  try {
    localStorage.setItem(FEATURE_BAR_COLLAPSED_STORE, isCollapsed ? "1" : "0");
  } catch (_error) {
    // Ignore storage failures.
  }
}

function buildRegionStats(entries) {
  const counter = new Map();
  entries.forEach((entry) => {
    const regionInfo = extractRegionInfo(entry.location);
    const prev = counter.get(regionInfo.region) || 0;
    counter.set(regionInfo.region, prev + 1);
  });

  return [...counter.entries()]
    .map(([region, count]) => ({ region, count }))
    .sort((a, b) => b.count - a.count || a.region.localeCompare(b.region, "zh-CN"));
}

function extractRegionInfo(locationValue) {
  const location = String(locationValue || "").trim();
  if (!location) {
    return { region: "\u672a\u77e5\u5730\u533a" };
  }

  const provinces = [
    "\u5317\u4eac", "\u5929\u6d25", "\u4e0a\u6d77", "\u91cd\u5e86", "\u6cb3\u5317", "\u5c71\u897f", "\u8fbd\u5b81", "\u5409\u6797",
    "\u9ed1\u9f99\u6c5f", "\u6c5f\u82cf", "\u6d59\u6c5f", "\u5b89\u5fbd", "\u798f\u5efa", "\u6c5f\u897f", "\u5c71\u4e1c", "\u6cb3\u5357",
    "\u6e56\u5317", "\u6e56\u5357", "\u5e7f\u4e1c", "\u6d77\u5357", "\u56db\u5ddd", "\u8d35\u5dde", "\u4e91\u5357", "\u9655\u897f",
    "\u7518\u8083", "\u9752\u6d77", "\u53f0\u6e7e", "\u5185\u8499\u53e4", "\u5e7f\u897f", "\u897f\u85cf", "\u5b81\u590f", "\u65b0\u7586",
    "\u9999\u6e2f", "\u6fb3\u95e8"
  ];

  const parts = location
    .replace(/[\u00B7\u2022\u30FB,\uFF0C\u3001/|\\-]+/g, "|")
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);

  const first = parts[0] || "";
  const second = parts[1] || "";
  const firstLower = first.toLowerCase();
  const isChinaHead =
    first === "\u4e2d\u56fd" ||
    first === "\u4e2d\u570b" ||
    first === "\u4e2d\u56fd\u5927\u9646" ||
    firstLower === "china" ||
    firstLower === "cn" ||
    firstLower === "prc";

  if (isChinaHead) {
    const province = findProvinceName(second || location, provinces);
    return { region: province || second || "\u4e2d\u56fd" };
  }

  const provinceFromText = findProvinceName(location, provinces);
  if (provinceFromText) {
    return { region: provinceFromText };
  }

  return { region: first || location };
}

function findProvinceName(text, provinces) {
  const source = String(text || "");
  return provinces.find((province) => source.includes(province)) || "";
}

function loadEditKeys() {
  try {
    const raw = localStorage.getItem(EDIT_KEY_STORE);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed;
  } catch (_error) {
    return {};
  }
}

function rememberEditKey(entryId, editKey) {
  if (!entryId || !editKey) {
    return;
  }
  cachedEditKeys[String(entryId)] = editKey;
  localStorage.setItem(EDIT_KEY_STORE, JSON.stringify(cachedEditKeys));
}

function formatDate(dateInput) {
  return dateFormatter.format(new Date(dateInput));
}

function formatDateTime(dateInput) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(dateInput));
}

async function fetchJSON(url, options = {}) {
  const response = await fetch(url, options);
  let payload = null;
  try {
    payload = await response.json();
  } catch (_error) {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(payload?.error || "请求失败");
  }
  return payload;
}

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toastEl.classList.remove("show");
  }, 2600);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}
