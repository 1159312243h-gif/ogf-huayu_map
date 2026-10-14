(() => {
  "use strict";

  const OWNER_KEY = "ogf-atlas-account-cache-owner";
  const OVERLAY_SOURCE_MAX_BYTES = 16 * 1024 * 1024;
  const OVERLAY_STORED_MAX_BYTES = 768 * 1024;
  const OVERLAY_MAX_DIMENSION = 2048;
  const OVERLAY_FILE_PROMPT = "PNG、JPEG 或 WebP，自动压缩至 768 KiB";
  const ERROR_MESSAGES = {
    personal_data_service_not_configured: "账号数据服务尚未完成 Cloudflare 配置。",
    personal_data_failure: "账号数据服务暂时不可用，请稍后重试。",
    authentication_required: "登录状态已失效，请重新登录。",
    invalid_username: "用户名需为 3 至 32 个汉字、字母、数字、下划线或连字符。",
    invalid_password: "密码长度需为 10 至 128 个字符。",
    username_taken: "该用户名已被使用。",
    invalid_credentials: "用户名或密码不正确。",
    invalid_current_password: "当前密码不正确。",
    invalid_display_name: "请输入显示名称。",
    invalid_image: "请选择 PNG、JPEG 或 WebP 图片。",
    source_image_too_large: "原始图片不能超过 16 MiB。",
    image_too_large: "图片压缩后仍超过 768 KiB，请选择尺寸更小的图片。",
    invalid_bounds: "贴图范围无效或跨度超过 30 度。",
    overlay_limit_reached: "每个账号最多保存 20 张贴图。",
    overlay_storage_limit_reached: "当前账号的贴图已达到 10 MiB 存储上限。",
    overlay_not_found: "贴图不存在或已被删除。",
    administrator_required: "当前账号没有用户管理权限。",
    cannot_lock_current_admin: "不能停用当前管理员账号或移除其权限。",
    cannot_delete_current_admin: "不能从用户列表删除当前管理员账号。",
    cross_origin_request_blocked: "请求来源校验失败，请刷新页面后重试。",
  };

  function codedError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(codedError("invalid_image"));
      };
      image.src = url;
    });
  }

  function canvasBlob(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(codedError("invalid_image")), "image/webp", quality);
    });
  }

  async function prepareOverlayImage(file) {
    if (!file || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      throw codedError("invalid_image");
    }
    if (file.size <= 0 || file.size > OVERLAY_SOURCE_MAX_BYTES) {
      throw codedError("source_image_too_large");
    }
    const image = await loadImage(file);
    if (!image.naturalWidth || !image.naturalHeight) throw codedError("invalid_image");
    const initialScale = Math.min(1, OVERLAY_MAX_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight));
    if (initialScale === 1 && file.size <= OVERLAY_STORED_MAX_BYTES) return file;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw codedError("invalid_image");
    let scale = initialScale;
    for (let resize = 0; resize < 7; resize += 1) {
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.86, 0.76, 0.66, 0.56, 0.46]) {
        const blob = await canvasBlob(canvas, quality);
        if (blob.size <= OVERLAY_STORED_MAX_BYTES) {
          const baseName = String(file.name || "地图贴图").replace(/\.[^.]+$/u, "") || "地图贴图";
          const outputType = ["image/png", "image/jpeg", "image/webp"].includes(blob.type)
            ? blob.type : "image/webp";
          const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[outputType];
          return new File([blob], `${baseName}.${extension}`, { type: outputType, lastModified: Date.now() });
        }
      }
      scale *= 0.78;
    }
    throw codedError("image_too_large");
  }

  function start() {
    const atlas = window.HuayuAtlas;
    if (!atlas || window.HuayuPersonalData) return;

    const elements = {
      authStatus: document.getElementById("account-status"),
      guest: document.getElementById("account-guest"),
      member: document.getElementById("account-member"),
      authModes: [...document.querySelectorAll("[data-auth-mode]")],
      loginForm: document.getElementById("login-form"),
      registerForm: document.getElementById("register-form"),
      accountDisplayName: document.getElementById("account-display-name"),
      accountUsername: document.getElementById("account-username"),
      accountRole: document.getElementById("account-role"),
      accountSearchCount: document.getElementById("account-search-count"),
      accountFavoriteCount: document.getElementById("account-favorite-count"),
      accountOverlayCount: document.getElementById("account-overlay-count"),
      profileForm: document.getElementById("profile-form"),
      profileDisplayName: document.getElementById("profile-display-name"),
      passwordForm: document.getElementById("password-form"),
      logout: document.getElementById("account-logout"),
      deleteAccount: document.getElementById("account-delete"),
      adminSection: document.getElementById("admin-users"),
      adminRefresh: document.getElementById("admin-refresh"),
      adminList: document.getElementById("admin-user-list"),
      overlayAuthStatus: document.getElementById("overlay-auth-status"),
      overlayForm: document.getElementById("overlay-upload-form"),
      overlayName: document.getElementById("overlay-name"),
      overlayImage: document.getElementById("overlay-image"),
      overlayFileName: document.getElementById("overlay-file-name"),
      overlayOpacity: document.getElementById("overlay-opacity"),
      overlayOpacityValue: document.getElementById("overlay-opacity-value"),
      overlayPickBounds: document.getElementById("overlay-pick-bounds"),
      overlayCancelPick: document.getElementById("overlay-cancel-pick"),
      overlayBoundsStatus: document.getElementById("overlay-bounds-status"),
      overlayUpload: document.getElementById("overlay-upload"),
      overlayCount: document.getElementById("overlay-count"),
      overlayList: document.getElementById("overlay-list"),
      pickBanner: document.getElementById("pick-banner"),
      pickMessage: document.getElementById("pick-message"),
    };

    let user = null;
    let overlays = [];
    let serviceAvailable = true;
    let pickingBounds = false;
    let pickStart = null;
    let selectedBounds = null;
    let draftLayer = null;
    const overlayLayers = new Map();
    const syncTimers = new Map();

    if (!atlas.map.getPane("personal-overlays")) {
      const pane = atlas.map.createPane("personal-overlays");
      pane.style.zIndex = "360";
      pane.style.pointerEvents = "none";
    }

    function errorMessage(error) {
      return ERROR_MESSAGES[error?.code] || ERROR_MESSAGES[error?.message]
        || (error?.status >= 500 ? "服务暂时不可用，请稍后重试。" : "操作未完成，请重试。");
    }

    function setStatus(element, message, isError = false) {
      element.textContent = message;
      element.classList.toggle("is-error", Boolean(isError));
    }

    async function api(path, options = {}) {
      const init = { method: options.method || "GET", credentials: "same-origin", headers: { Accept: "application/json" } };
      if (options.body !== undefined) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(options.body);
      } else if (options.form) {
        init.body = options.form;
      }
      const response = await fetch(path, init);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(payload.error || `HTTP_${response.status}`);
        error.code = payload.error;
        error.status = response.status;
        throw error;
      }
      return payload;
    }

    function localSnapshot() {
      return { searchHistory: atlas.getSearchHistory(), favorites: atlas.getFavorites() };
    }

    function applySnapshot(payload) {
      atlas.applyPersonalDataSnapshot({
        searchHistory: payload.searchHistory || [],
        favorites: payload.favorites || {},
      });
      overlays = Array.isArray(payload.overlays) ? payload.overlays : overlays;
      renderOverlayLayers();
      renderOverlayList();
      renderAccount();
    }

    async function activateUser(payload, mergeLocal) {
      user = payload.user;
      serviceAvailable = true;
      let data = payload;
      if (mergeLocal) {
        try {
          data = { ...payload, ...await api("/api/personal/sync", { method: "POST", body: localSnapshot() }) };
        } catch (error) {
          atlas.showToast(`本机数据稍后同步：${errorMessage(error)}`);
        }
      }
      window.localStorage.setItem(OWNER_KEY, user.id);
      applySnapshot(data);
      renderAuthState();
    }

    function clearAccountCache() {
      atlas.applyPersonalDataSnapshot({ searchHistory: [], favorites: {} });
      overlays = [];
      window.localStorage.removeItem(OWNER_KEY);
      renderOverlayLayers();
      renderOverlayList();
    }

    function renderAuthState() {
      elements.guest.hidden = Boolean(user);
      elements.member.hidden = !user;
      elements.overlayForm.hidden = !user;
      elements.adminSection.hidden = user?.role !== "admin";
      if (user) {
        setStatus(elements.authStatus, `已登录为 ${user.displayName}`);
        setStatus(elements.overlayAuthStatus, "贴图仅对当前账号可见。", false);
      } else {
        setStatus(elements.authStatus, serviceAvailable ? "登录后可同步搜索、收藏和贴图。" : ERROR_MESSAGES.personal_data_service_not_configured,
          !serviceAvailable);
        setStatus(elements.overlayAuthStatus, serviceAvailable ? "请先登录账号后上传和管理贴图。"
          : ERROR_MESSAGES.personal_data_service_not_configured, !serviceAvailable);
      }
      renderAccount();
      updateUploadAvailability();
    }

    function renderAccount() {
      if (!user) return;
      const favorites = Object.keys(atlas.getFavorites()).length;
      elements.accountDisplayName.textContent = user.displayName;
      elements.accountUsername.textContent = `@${user.username}`;
      elements.accountRole.textContent = user.role === "admin" ? "管理员" : "用户";
      elements.profileDisplayName.value = user.displayName;
      elements.accountSearchCount.textContent = String(atlas.getSearchHistory().length);
      elements.accountFavoriteCount.textContent = String(favorites);
      elements.accountOverlayCount.textContent = String(overlays.length);
    }

    function setAuthMode(mode) {
      const register = mode === "register";
      elements.loginForm.hidden = register;
      elements.registerForm.hidden = !register;
      elements.authModes.forEach((button) => {
        const active = button.dataset.authMode === mode;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-selected", String(active));
      });
      (register ? elements.registerForm : elements.loginForm).querySelector("input")?.focus();
    }

    async function submitAuth(form, register) {
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      setStatus(elements.authStatus, register ? "正在创建账号…" : "正在登录…");
      try {
        const values = Object.fromEntries(new FormData(form));
        const payload = await api(register ? "/api/auth/register" : "/api/auth/login", {
          method: "POST",
          body: values,
        });
        await activateUser(payload, true);
        form.reset();
        atlas.showToast(register ? "账号已创建" : "登录成功");
      } catch (error) {
        setStatus(elements.authStatus, errorMessage(error), true);
      } finally {
        submit.disabled = false;
      }
    }

    async function logout() {
      try {
        await api("/api/auth/logout", { method: "POST", body: {} });
      } catch (error) {
        atlas.showToast(errorMessage(error));
        return;
      }
      user = null;
      cancelBoundsPick(true);
      clearAccountCache();
      renderAuthState();
      atlas.showToast("已退出登录");
    }

    function queueSync(kind, items) {
      if (!user) return;
      window.clearTimeout(syncTimers.get(kind));
      syncTimers.set(kind, window.setTimeout(async () => {
        try {
          const path = kind === "favorites" ? "/api/personal/favorites" : "/api/personal/search-history";
          await api(path, { method: "PUT", body: { items } });
          renderAccount();
        } catch (error) {
          if (error.status === 401) await logout();
          else atlas.showToast(errorMessage(error));
        }
      }, 250));
    }

    function formatBytes(bytes) {
      return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${Math.ceil(bytes / 1024)} KiB`;
    }

    function boundsArray(bounds) {
      return [[bounds.south, bounds.west], [bounds.north, bounds.east]];
    }

    function removeOverlayLayer(id) {
      const layer = overlayLayers.get(id);
      if (layer) atlas.map.removeLayer(layer);
      overlayLayers.delete(id);
    }

    function renderOverlayLayers() {
      const ids = new Set(overlays.map((overlay) => overlay.id));
      [...overlayLayers.keys()].filter((id) => !ids.has(id)).forEach(removeOverlayLayer);
      overlays.forEach((overlay) => {
        if (!overlay.visible || !user) {
          removeOverlayLayer(overlay.id);
          return;
        }
        let layer = overlayLayers.get(overlay.id);
        if (!layer) {
          layer = window.L.imageOverlay(overlay.imageUrl, boundsArray(overlay.bounds), {
            opacity: overlay.opacity,
            pane: "personal-overlays",
            interactive: false,
            alt: overlay.name,
          });
          layer.on("error", () => atlas.showToast(`无法读取贴图：${overlay.name}`));
          overlayLayers.set(overlay.id, layer);
        }
        layer.setOpacity(overlay.opacity);
        layer.setBounds(boundsArray(overlay.bounds));
        if (!atlas.map.hasLayer(layer)) layer.addTo(atlas.map);
      });
    }

    function actionButton(icon, label, className = "small-icon-button") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = className;
      button.setAttribute("aria-label", label);
      button.dataset.tooltip = label;
      const glyph = document.createElement("i");
      glyph.dataset.lucide = icon;
      glyph.setAttribute("aria-hidden", "true");
      button.appendChild(glyph);
      return button;
    }

    async function updateOverlay(overlay, patch) {
      const previous = { ...overlay };
      Object.assign(overlay, patch);
      renderOverlayLayers();
      renderOverlayList();
      try {
        await api(`/api/overlays/${encodeURIComponent(overlay.id)}`, { method: "PATCH", body: patch });
      } catch (error) {
        Object.assign(overlay, previous);
        renderOverlayLayers();
        renderOverlayList();
        atlas.showToast(errorMessage(error));
      }
    }

    function renderOverlayList() {
      elements.overlayList.replaceChildren();
      elements.overlayCount.textContent = String(overlays.length);
      if (!user) {
        const empty = document.createElement("p");
        empty.className = "view-status";
        empty.textContent = "登录后显示个人贴图。";
        elements.overlayList.appendChild(empty);
        return;
      }
      if (!overlays.length) {
        const empty = document.createElement("p");
        empty.className = "view-status";
        empty.textContent = "尚未上传贴图。";
        elements.overlayList.appendChild(empty);
        return;
      }
      overlays.forEach((overlay) => {
        const row = document.createElement("section");
        row.className = "overlay-item";
        const preview = document.createElement("img");
        preview.src = overlay.imageUrl;
        preview.alt = "";
        preview.loading = "lazy";
        const copy = document.createElement("div");
        copy.className = "overlay-item-copy";
        const name = document.createElement("input");
        name.value = overlay.name;
        name.maxLength = 100;
        name.setAttribute("aria-label", "贴图名称");
        name.addEventListener("change", () => {
          const value = name.value.trim();
          if (value && value !== overlay.name) updateOverlay(overlay, { name: value });
          else name.value = overlay.name;
        });
        const meta = document.createElement("span");
        meta.textContent = `${formatBytes(overlay.byteSize)} · ${overlay.bounds.west.toFixed(4)}, ${overlay.bounds.south.toFixed(4)} 至 ${overlay.bounds.east.toFixed(4)}, ${overlay.bounds.north.toFixed(4)}`;
        copy.append(name, meta);
        const visible = document.createElement("label");
        visible.className = "overlay-visible-toggle";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = overlay.visible;
        checkbox.setAttribute("aria-label", `显示${overlay.name}`);
        checkbox.addEventListener("change", () => updateOverlay(overlay, { visible: checkbox.checked }));
        const switchElement = document.createElement("span");
        switchElement.className = "map-selection-switch";
        switchElement.setAttribute("aria-hidden", "true");
        visible.append(checkbox, switchElement);
        const opacity = document.createElement("input");
        opacity.className = "overlay-item-opacity";
        opacity.type = "range";
        opacity.min = "10";
        opacity.max = "100";
        opacity.step = "5";
        opacity.value = String(Math.round(overlay.opacity * 100));
        opacity.setAttribute("aria-label", `${overlay.name}透明度`);
        opacity.addEventListener("input", () => {
          overlay.opacity = Number(opacity.value) / 100;
          renderOverlayLayers();
        });
        opacity.addEventListener("change", () => updateOverlay(overlay, { opacity: Number(opacity.value) / 100 }));
        const actions = document.createElement("div");
        actions.className = "overlay-item-actions";
        const fit = actionButton("focus", "定位贴图");
        fit.addEventListener("click", () => atlas.map.fitBounds(boundsArray(overlay.bounds), { padding: [30, 30], maxZoom: 16 }));
        const remove = actionButton("trash-2", "删除贴图", "small-icon-button is-danger");
        remove.addEventListener("click", async () => {
          if (!window.confirm(`删除贴图“${overlay.name}”？图片也会从账号数据中删除。`)) return;
          remove.disabled = true;
          try {
            await api(`/api/overlays/${encodeURIComponent(overlay.id)}`, { method: "DELETE" });
            overlays = overlays.filter((item) => item.id !== overlay.id);
            removeOverlayLayer(overlay.id);
            renderOverlayList();
            renderAccount();
            atlas.showToast("贴图已删除");
          } catch (error) {
            remove.disabled = false;
            atlas.showToast(errorMessage(error));
          }
        });
        actions.append(fit, remove);
        row.append(preview, copy, visible, opacity, actions);
        elements.overlayList.appendChild(row);
      });
      atlas.refreshIcons();
    }

    function ensureDraftLayer() {
      if (!draftLayer) draftLayer = window.L.layerGroup().addTo(atlas.map);
      if (!atlas.map.hasLayer(draftLayer)) draftLayer.addTo(atlas.map);
      return draftLayer;
    }

    function startBoundsPick() {
      if (!user) {
        atlas.showToast("请先登录账号");
        return;
      }
      pickingBounds = true;
      pickStart = null;
      selectedBounds = null;
      ensureDraftLayer().clearLayers();
      elements.overlayCancelPick.hidden = false;
      elements.overlayPickBounds.disabled = true;
      elements.overlayBoundsStatus.textContent = "点击第一个对角点";
      elements.pickMessage.textContent = "点击贴图范围的第一个对角点";
      elements.pickBanner.hidden = false;
      atlas.map.getContainer().classList.add("is-overlay-picking");
      atlas.hidePanel();
      updateUploadAvailability();
    }

    function cancelBoundsPick(clearSelection = false) {
      const wasPicking = pickingBounds;
      pickingBounds = false;
      pickStart = null;
      elements.overlayCancelPick.hidden = true;
      elements.overlayPickBounds.disabled = false;
      elements.pickBanner.hidden = true;
      atlas.map.getContainer().classList.remove("is-overlay-picking");
      if (wasPicking) atlas.showPanel();
      if (clearSelection) {
        selectedBounds = null;
        draftLayer?.clearLayers();
        elements.overlayBoundsStatus.textContent = "尚未选择范围";
      }
      updateUploadAvailability();
    }

    function handleBoundsClick(event) {
      if (!pickingBounds) return;
      const point = { lat: Number(event.latlng.lat.toFixed(7)), lng: Number(event.latlng.lng.toFixed(7)) };
      const layer = ensureDraftLayer();
      if (!pickStart) {
        pickStart = point;
        layer.clearLayers();
        window.L.circleMarker([point.lat, point.lng], {
          radius: 5, color: "#ffffff", weight: 2, fillColor: "#087f78", fillOpacity: 1, interactive: false,
        }).addTo(layer);
        elements.overlayBoundsStatus.textContent = "点击另一个对角点";
        elements.pickMessage.textContent = "点击贴图范围的另一个对角点";
        return;
      }
      const bounds = {
        west: Math.min(pickStart.lng, point.lng), south: Math.min(pickStart.lat, point.lat),
        east: Math.max(pickStart.lng, point.lng), north: Math.max(pickStart.lat, point.lat),
      };
      if (bounds.east - bounds.west < 0.000001 || bounds.north - bounds.south < 0.000001
        || bounds.east - bounds.west > 30 || bounds.north - bounds.south > 30) {
        atlas.showToast(ERROR_MESSAGES.invalid_bounds);
        startBoundsPick();
        return;
      }
      selectedBounds = bounds;
      layer.clearLayers();
      window.L.rectangle(boundsArray(bounds), {
        color: "#087f78", weight: 2, opacity: 0.95, fillColor: "#087f78", fillOpacity: 0.08,
        dashArray: "7 5", interactive: false,
      }).addTo(layer);
      elements.overlayBoundsStatus.textContent = `${bounds.west.toFixed(4)}, ${bounds.south.toFixed(4)} 至 ${bounds.east.toFixed(4)}, ${bounds.north.toFixed(4)}`;
      cancelBoundsPick(false);
      elements.overlayPickBounds.innerHTML = '<i data-lucide="scan" aria-hidden="true"></i>重新框选';
      atlas.refreshIcons();
    }

    function updateUploadAvailability() {
      const file = elements.overlayImage.files?.[0];
      elements.overlayUpload.disabled = !user || !file || !selectedBounds || pickingBounds;
    }

    async function uploadOverlay(event) {
      event.preventDefault();
      const image = elements.overlayImage.files?.[0];
      if (!user || !image || !selectedBounds) return;
      elements.overlayUpload.disabled = true;
      try {
        setStatus(elements.overlayAuthStatus, "正在处理图片…");
        const preparedImage = await prepareOverlayImage(image);
        setStatus(elements.overlayAuthStatus, "正在上传贴图…");
        const form = new FormData();
        form.set("image", preparedImage);
        form.set("name", elements.overlayName.value.trim());
        form.set("opacity", String(Number(elements.overlayOpacity.value) / 100));
        Object.entries(selectedBounds).forEach(([key, value]) => form.set(key, String(value)));
        const payload = await api("/api/overlays", { method: "POST", form });
        overlays.unshift(payload.overlay);
        elements.overlayForm.reset();
        elements.overlayOpacity.value = "75";
        elements.overlayOpacityValue.value = "75%";
        elements.overlayFileName.value = OVERLAY_FILE_PROMPT;
        elements.overlayPickBounds.innerHTML = '<i data-lucide="scan" aria-hidden="true"></i>框选范围';
        cancelBoundsPick(true);
        renderOverlayLayers();
        renderOverlayList();
        renderAccount();
        setStatus(elements.overlayAuthStatus, "贴图已保存到当前账号。", false);
        atlas.showToast("贴图上传完成");
        atlas.refreshIcons();
      } catch (error) {
        setStatus(elements.overlayAuthStatus, errorMessage(error), true);
        updateUploadAvailability();
      }
    }

    async function loadAdminUsers() {
      if (user?.role !== "admin") return;
      elements.adminRefresh.disabled = true;
      try {
        const payload = await api("/api/admin/users");
        renderAdminUsers(payload.users || []);
      } catch (error) {
        elements.adminList.textContent = errorMessage(error);
      } finally {
        elements.adminRefresh.disabled = false;
      }
    }

    function renderAdminUsers(users) {
      elements.adminList.replaceChildren();
      users.forEach((item) => {
        const row = document.createElement("div");
        row.className = "admin-user-row";
        const identity = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = item.displayName;
        const detail = document.createElement("span");
        detail.textContent = `@${item.username} · ${item.searchCount} 搜索 · ${item.favoriteCount} 收藏 · ${item.overlayCount} 贴图`;
        identity.append(title, detail);
        const role = document.createElement("select");
        role.setAttribute("aria-label", `${item.username}的角色`);
        [["user", "用户"], ["admin", "管理员"]].forEach(([value, label]) => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = label;
          option.selected = item.role === value;
          role.appendChild(option);
        });
        role.disabled = item.id === user.id;
        role.addEventListener("change", async () => {
          try {
            await api(`/api/admin/users/${encodeURIComponent(item.id)}`, {
              method: "PATCH", body: { role: role.value },
            });
            await loadAdminUsers();
          } catch (error) {
            role.value = item.role;
            atlas.showToast(errorMessage(error));
          }
        });
        const active = document.createElement("label");
        active.className = "admin-user-active";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = !item.disabled;
        checkbox.disabled = item.id === user.id;
        checkbox.addEventListener("change", async () => {
          try {
            await api(`/api/admin/users/${encodeURIComponent(item.id)}`, {
              method: "PATCH", body: { disabled: !checkbox.checked },
            });
          } catch (error) {
            checkbox.checked = !checkbox.checked;
            atlas.showToast(errorMessage(error));
          }
        });
        active.append(checkbox, document.createTextNode("启用"));
        const remove = actionButton("trash-2", `删除用户${item.username}`, "small-icon-button is-danger");
        remove.disabled = item.id === user.id;
        remove.addEventListener("click", async () => {
          if (!window.confirm(`永久删除用户“${item.username}”及其全部数据？`)) return;
          try {
            await api(`/api/admin/users/${encodeURIComponent(item.id)}`, { method: "DELETE" });
            await loadAdminUsers();
          } catch (error) {
            atlas.showToast(errorMessage(error));
          }
        });
        const controls = document.createElement("div");
        controls.className = "admin-user-controls";
        controls.append(role, active, remove);
        row.append(identity, controls);
        elements.adminList.appendChild(row);
      });
      atlas.refreshIcons();
    }

    async function restoreSession() {
      setStatus(elements.authStatus, "正在检查登录状态…");
      try {
        const payload = await api("/api/auth/session");
        const owner = window.localStorage.getItem(OWNER_KEY);
        await activateUser(payload, owner !== payload.user.id);
      } catch (error) {
        if (error.status === 503) serviceAvailable = false;
        if (error.status === 401 && window.localStorage.getItem(OWNER_KEY)) clearAccountCache();
        user = null;
        renderAuthState();
      }
    }

    elements.authModes.forEach((button) => button.addEventListener("click", () => setAuthMode(button.dataset.authMode)));
    elements.loginForm.addEventListener("submit", (event) => { event.preventDefault(); submitAuth(elements.loginForm, false); });
    elements.registerForm.addEventListener("submit", (event) => { event.preventDefault(); submitAuth(elements.registerForm, true); });
    elements.logout.addEventListener("click", logout);
    elements.profileForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const payload = await api("/api/account", {
          method: "PATCH", body: { displayName: elements.profileDisplayName.value },
        });
        user = payload.user;
        renderAuthState();
        atlas.showToast("个人资料已保存");
      } catch (error) { setStatus(elements.authStatus, errorMessage(error), true); }
    });
    elements.passwordForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(elements.passwordForm));
      try {
        const payload = await api("/api/account", { method: "PATCH", body: { ...values, displayName: user.displayName } });
        user = payload.user;
        elements.passwordForm.reset();
        renderAuthState();
        atlas.showToast("密码已更新，其他设备已退出登录");
      } catch (error) { setStatus(elements.authStatus, errorMessage(error), true); }
    });
    elements.deleteAccount.addEventListener("click", async () => {
      const password = window.prompt("请输入当前密码以删除账号：");
      if (!password || !window.confirm("永久删除账号、收藏、搜索记录和全部贴图？此操作无法撤销。")) return;
      try {
        await api("/api/account", { method: "DELETE", body: { password } });
        user = null;
        clearAccountCache();
        renderAuthState();
        atlas.showToast("账号及个人数据已删除");
      } catch (error) { setStatus(elements.authStatus, errorMessage(error), true); }
    });
    elements.adminRefresh.addEventListener("click", loadAdminUsers);
    elements.overlayOpacity.addEventListener("input", () => {
      elements.overlayOpacityValue.value = `${elements.overlayOpacity.value}%`;
    });
    elements.overlayImage.addEventListener("change", () => {
      const file = elements.overlayImage.files?.[0];
      elements.overlayFileName.value = file ? `${file.name} · ${formatBytes(file.size)}` : OVERLAY_FILE_PROMPT;
      if (file && !elements.overlayName.value) elements.overlayName.value = file.name.replace(/\.[^.]+$/u, "");
      updateUploadAvailability();
    });
    elements.overlayPickBounds.addEventListener("click", startBoundsPick);
    elements.overlayCancelPick.addEventListener("click", () => cancelBoundsPick(true));
    elements.overlayForm.addEventListener("submit", uploadOverlay);
    atlas.map.getContainer().addEventListener("click", (event) => {
      if (!pickingBounds || event.target.closest(".leaflet-control, .leaflet-popup")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      handleBoundsClick({ latlng: atlas.map.mouseEventToLatLng(event) });
    }, { capture: true });
    window.addEventListener("huayu:personal-data-changed", (event) => queueSync(event.detail?.kind, event.detail?.items));

    window.HuayuPersonalData = Object.freeze({
      isAuthenticated: () => Boolean(user),
      isPickingBounds: () => pickingBounds,
      renderView(view) {
        if (view === "account") {
          renderAuthState();
          if (user?.role === "admin") loadAdminUsers();
        }
        if (view === "overlays") {
          renderAuthState();
          renderOverlayList();
        }
      },
    });

    renderAuthState();
    renderOverlayList();
    restoreSession();
  }

  if (window.HuayuAtlas) start();
  else window.addEventListener("huayu:map-ready", start, { once: true });
})();
