const API = "http://localhost:3000/api";
const $ = (id) => document.getElementById(id);
const state = {
  token: localStorage.getItem("pulse_token"),
  user: JSON.parse(localStorage.getItem("pulse_user") || "null"),
  socket: null,
  conversations: [],
  active: null,
  online: new Set(),
  typing: new Map(),
  authMode: "login",
  typingTimer: null,
  toastTimer: null,
};

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
}
function initials(name = "?") {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((x) => x[0] || "")
    .join("")
    .toUpperCase();
}
function escapeHTML(value = "") {
  return String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
function authHeaders() {
  return {
    "Content-Type": "application/json",
    ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
  };
}
async function api(path, options = {}) {
  const response = await fetch(API + path, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "Request failed");
  return data;
}
function setAuthMode(mode) {
  state.authMode = mode;
  const register = mode === "register";
  $("authTitle").textContent = register ? "Make it yours." : "Welcome back.";
  $("authSubtitle").textContent = register
    ? "Create an account and find your people."
    : "Sign in to pick up the conversation.";
  $("nameWrap").classList.toggle("hidden", !register);
  $("nameInput").required = register;
  $("authSubmit").innerHTML = register
    ? "Create account <span>↗</span>"
    : "Sign in <span>↗</span>";
  $("authSwitch").innerHTML = register
    ? 'Already have an account? <button type="button" class="text-button" id="switchAuth">Sign in</button>'
    : 'New to Pulse? <button type="button" class="text-button" id="switchAuth">Create an account</button>';
  $("switchAuth").addEventListener("click", () =>
    setAuthMode(register ? "login" : "register"),
  );
}
$("switchAuth").addEventListener("click", () => setAuthMode("register"));
$("authForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {
    email: $("emailInput").value.trim(),
    password: $("passwordInput").value,
  };
  if (state.authMode === "register") payload.name = $("nameInput").value.trim();
  $("authSubmit").disabled = true;
  try {
    const result = await api(
      "/auth/" + (state.authMode === "register" ? "register" : "login"),
      { method: "POST", body: JSON.stringify(payload), headers: {} },
    );
    state.token = result.token;
    state.user = result.user;
    localStorage.setItem("pulse_token", state.token);
    localStorage.setItem("pulse_user", JSON.stringify(state.user));
    showChat();
  } catch (err) {
    toast(err.message);
  } finally {
    $("authSubmit").disabled = false;
  }
});

function showChat() {
  $("authView").classList.add("hidden");
  $("chatView").classList.remove("hidden");
  $("myName").textContent = state.user?.name || "My profile";
  $("myAvatar").textContent = initials(state.user?.name);
  connectSocket();
  loadConversations();
}
function logout() {
  if (state.socket) state.socket.disconnect();
  state.socket = null;
  state.token = null;
  state.user = null;
  state.active = null;
  localStorage.removeItem("pulse_token");
  localStorage.removeItem("pulse_user");
  $("chatView").classList.add("hidden");
  $("authView").classList.remove("hidden");
  $("conversationPane").classList.add("hidden");
  $("chatHeader").classList.remove("hidden");
}
$("logoutBtn").addEventListener("click", logout);
$("themeToggle").addEventListener("click", () => {
  document.body.classList.toggle("dark");
  localStorage.setItem(
    "pulse_dark",
    document.body.classList.contains("dark") ? "1" : "0",
  );
});
if (localStorage.getItem("pulse_dark") === "1")
  document.body.classList.add("dark");

function connectSocket() {
  if (state.socket) state.socket.disconnect();
  state.socket = io("http://localhost:3000", {
    auth: { token: state.token },
    reconnection: true,
    reconnectionAttempts: 8,
    reconnectionDelay: 700,
  });
  state.socket.on("connect", () => {
    $("connectionStatus").classList.add("connected");
    $("connectionStatus").lastChild.textContent = " Live";
  });
  state.socket.on("disconnect", () => {
    $("connectionStatus").classList.remove("connected");
    $("connectionStatus").lastChild.textContent = " Reconnecting…";
  });
  state.socket.on("connect_error", (err) => {
    $("connectionStatus").classList.remove("connected");
    $("connectionStatus").lastChild.textContent = " Connection issue";
    if (/token|auth/i.test(err.message))
      toast("Session expired. Please sign in again.");
  });
  state.socket.on("presence:snapshot", ({ userIds = [] }) => {
    state.online = new Set(userIds);
    renderConversations();
  });
  state.socket.on("presence:update", ({ userId, online }) => {
    if (online) state.online.add(userId);
    else state.online.delete(userId);
    renderConversations();
    if (state.active) updateActiveSubtitle();
  });
  state.socket.on("message:new", (message) => {
    if (
      state.active &&
      String(message.conversation) === String(state.active._id)
    ) {
      appendMessage(message);
      $("messages").scrollTop = $("messages").scrollHeight;
      if (message.sender?._id !== state.user.id)
        state.socket.emit("message:read", { conversationId: state.active._id });
    }
    loadConversations(true);
  });
  state.socket.on("typing:update", (data) => {
    if (!state.active || data.conversationId !== state.active._id) return;
    if (data.typing) state.typing.set(data.userId, data.name || "Someone");
    else state.typing.delete(data.userId);
    $("typingLine").textContent =
      [...state.typing.values()].join(", ") +
      (state.typing.size ? " typing…" : "");
  });
  state.socket.on("conversation:read", ({ conversationId }) => {
    if (state.active?._id === conversationId) renderReadHint();
  });
  state.socket.on("message:reaction", ({ messageId, reactions }) => {
    const el = document.querySelector(
      `[data-message-id="${CSS.escape(String(messageId))}"] .reactions`,
    );
    if (el) el.textContent = reactions.map((r) => r.emoji).join(" ");
  });
}
async function loadConversations(quiet = false) {
  try {
    const result = await api("/conversations");
    state.conversations = result.conversations;
    renderConversations();
  } catch (err) {
    if (!quiet) toast(err.message);
  }
}
function conversationName(c) {
  if (c.type === "group") return c.title || "Untitled group";
  const other = (c.participants || []).find(
    (p) => String(p._id) !== String(state.user.id),
  );
  return other?.name || "Direct conversation";
}
function conversationOther(c) {
  return (c.participants || []).find(
    (p) => String(p._id) !== String(state.user.id),
  );
}
function renderConversations() {
  const query = $("searchInput").value.trim().toLowerCase();
  const list = state.conversations.filter((c) =>
    conversationName(c).toLowerCase().includes(query),
  );
  $("conversationList").innerHTML = list.length
    ? list
        .map((c) => {
          const other = conversationOther(c);
          const online = other && state.online.has(String(other._id));
          const last =
            c.lastMessage?.text ||
            (c.type === "group"
              ? "Group conversation"
              : "Start a conversation");
          return `<div class="conversation-item ${state.active?._id === c._id ? "active" : ""}" data-id="${escapeHTML(c._id)}"><div class="avatar">${escapeHTML(initials(conversationName(c)))}</div><div class="conversation-copy"><div class="line-one"><b>${escapeHTML(conversationName(c))}</b><time>${c.lastMessage?.createdAt ? new Date(c.lastMessage.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</time></div><p>${online ? "● Online · " : ""}${escapeHTML(last)}</p></div></div>`;
        })
        .join("")
    : '<div class="empty-side">No conversations found. Start a new chat with ＋.</div>';
  document
    .querySelectorAll(".conversation-item")
    .forEach((el) =>
      el.addEventListener("click", () => openConversation(el.dataset.id)),
    );
}
async function openConversation(id) {
  const conversation = state.conversations.find((c) => c._id === id);
  if (!conversation) return;
  state.active = conversation;
  state.typing.clear();
  $("chatHeader").classList.add("hidden");
  $("peoplePane").classList.add("hidden");
  $("conversationPane").classList.remove("hidden");
  $("chatView").classList.add("mobile-chat");
  $("activeTitle").textContent = conversationName(conversation);
  $("activeAvatar").textContent = initials(conversationName(conversation));
  updateActiveSubtitle();
  renderConversations();
  $("messages").innerHTML = '<div class="day-chip">RECENT MESSAGES</div>';
  try {
    const result = await api(`/conversations/${id}/messages`);
    result.messages.forEach(appendMessage);
    $("messages").scrollTop = $("messages").scrollHeight;
    state.socket.emit("message:read", { conversationId: id });
  } catch (err) {
    toast(err.message);
  }
}
function updateActiveSubtitle() {
  const other = state.active && conversationOther(state.active);
  $("activeSubtitle").textContent =
    state.active?.type === "group"
      ? `${state.active.participants.length} members`
      : other && state.online.has(String(other._id))
        ? "● Online now"
        : other?.lastSeen
          ? `Last seen ${new Date(other.lastSeen).toLocaleString()}`
          : "Messages update in real time";
}
function appendMessage(message) {
  if (
    !message ||
    !message._id ||
    document.querySelector(
      `[data-message-id="${CSS.escape(String(message._id))}"]`,
    )
  )
    return;
  const mine =
    String(message.sender?._id || message.sender) === String(state.user.id);
  const row = document.createElement("div");
  row.className = "message-row" + (mine ? " mine" : "");
  row.dataset.messageId = message._id;
  const senderName =
    message.sender?.name || (mine ? state.user.name : "Member");
  const time = message.createdAt
    ? new Date(message.createdAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "now";
  row.innerHTML = `<div class="avatar message-avatar">${escapeHTML(initials(senderName))}</div><div class="message-content">${mine ? "" : `<div class="message-author">${escapeHTML(senderName)}</div>`}<div class="bubble">${escapeHTML(message.text || "")}</div><div class="message-meta">${time}${message.editedAt ? " · edited" : ""} ${mine ? '<span class="read-hint"></span>' : ""}</div><div class="reactions"></div><button class="text-button react-button" type="button" title="React with a heart">♡ React</button></div>`;
  row.querySelector(".react-button").addEventListener("click", () =>
    state.socket.emit(
      "message:react",
      { messageId: message._id, emoji: "❤️" },
      (result) => {
        if (!result?.ok) toast(result?.message || "Could not react");
      },
    ),
  );
  $("messages").appendChild(row);
}
function renderReadHint() {
  document.querySelectorAll(".mine .read-hint").forEach((el) => {
    el.textContent = " ✓✓";
    el.style.color = "#30c994";
  });
}
$("messageForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = $("messageInput").value.trim();
  if (!text || !state.active) return;
  if (!state.socket?.connected)
    return toast("Reconnecting… try again in a moment.");
  state.socket.emit(
    "message:send",
    { conversationId: state.active._id, text },
    (result) => {
      if (!result?.ok) toast(result?.message || "Message failed");
    },
  );
  $("messageInput").value = "";
  $("messageInput").style.height = "auto";
  state.socket.emit("typing:stop", { conversationId: state.active._id });
});
$("messageInput").addEventListener("input", () => {
  const input = $("messageInput");
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 130) + "px";
  if (!state.active || !state.socket?.connected) return;
  state.socket.emit("typing:start", { conversationId: state.active._id });
  clearTimeout(state.typingTimer);
  state.typingTimer = setTimeout(
    () =>
      state.socket.emit("typing:stop", { conversationId: state.active?._id }),
    900,
  );
});
$("messageInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("messageForm").requestSubmit();
  }
});
$("emojiBtn").addEventListener("click", () => {
  const input = $("messageInput");
  input.value += " 😊";
  input.focus();
});
$("markReadBtn").addEventListener("click", () => {
  if (state.active)
    state.socket.emit(
      "message:read",
      { conversationId: state.active._id },
      (result) =>
        toast(
          result?.ok ? "Conversation marked as read" : "Could not mark as read",
        ),
    );
});
$("searchInput").addEventListener("input", renderConversations);
$("newChatBtn").addEventListener("click", () => {
  $("chatHeader").classList.add("hidden");
  $("conversationPane").classList.add("hidden");
  $("peoplePane").classList.remove("hidden");
  $("peopleSearch").value = "";
  $("peopleSearch").focus();
  loadPeople("");
});
$("closePeople").addEventListener("click", () => {
  $("peoplePane").classList.add("hidden");
  $("chatHeader").classList.remove("hidden");
  $("chatView").classList.remove("mobile-chat");
});
$("peopleSearch").addEventListener("input", () =>
  loadPeople($("peopleSearch").value.trim()),
);
let peopleRequest = 0;
async function loadPeople(query) {
  const requestId = ++peopleRequest;
  try {
    const result = await api("/users?q=" + encodeURIComponent(query));
    if (requestId !== peopleRequest) return;
    $("peopleList").innerHTML = result.users.length
      ? result.users
          .map(
            (u) =>
              `<div class="person-item"><div class="avatar">${escapeHTML(initials(u.name))}</div><div class="person-copy"><b>${escapeHTML(u.name)}</b><small>${escapeHTML(u.email)}</small></div><button data-user-id="${escapeHTML(u._id)}">Message ↗</button></div>`,
          )
          .join("")
      : '<div class="empty-side">No people found for that search.</div>';
    document
      .querySelectorAll(".person-item button")
      .forEach((btn) =>
        btn.addEventListener("click", () => startDirect(btn.dataset.userId)),
      );
  } catch (err) {
    toast(err.message);
  }
}
async function startDirect(userId) {
  try {
    const result = await api("/conversations/direct", {
      method: "POST",
      body: JSON.stringify({ userId }),
    });
    if (!state.conversations.some((c) => c._id === result.conversation._id))
      state.conversations.unshift(result.conversation);
    const conversation = result.conversation;
    // Join the newly created room without requiring a reconnect.
    state.socket.emit("conversation:join", {
      conversationId: conversation._id,
    });
    await loadConversations(true);
    openConversation(conversation._id);
  } catch (err) {
    toast(err.message);
  }
}

(async function boot() {
  if (!state.token || !state.user) return;
  try {
    const result = await api("/auth/me");
    state.user = result.user;
    localStorage.setItem("pulse_user", JSON.stringify(state.user));
    showChat();
  } catch {
    localStorage.removeItem("pulse_token");
    localStorage.removeItem("pulse_user");
    state.token = null;
    state.user = null;
  }
})();
