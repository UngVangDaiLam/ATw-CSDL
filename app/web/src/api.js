// Goi API cua app/ tu trinh duyet.
//
// - Cung origin, cookie phien secdb.sid tu di theo (HttpOnly - JavaScript o
//   day KHONG doc duoc no, va khong can doc).
// - Request ghi du lieu gui kem X-CSRF-Token (src/csrf.js phia server). Token
//   chi giu trong bo nho trang, khong cat vao localStorage.
// - Dang nhap xong server cap phien moi kem token moi -> cap nhat ngay.

let csrfToken = null;

export class ApiError extends Error {
  constructor(status, message, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function parse(res) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* phan hoi khong phai JSON */
  }
  if (!res.ok) {
    const retry = Number(res.headers.get('Retry-After')) || undefined;
    throw new ApiError(res.status, body?.message || `Loi ${res.status}`, retry);
  }
  return body;
}

export async function refreshCsrf() {
  const body = await parse(await fetch('/auth/csrf', { credentials: 'same-origin' }));
  csrfToken = body.csrfToken;
  return csrfToken;
}

export async function get(path) {
  return parse(await fetch(path, { credentials: 'same-origin' }));
}

async function send(method, path, data, retried = false) {
  if (!csrfToken) await refreshCsrf();
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify(data ?? {}),
  });
  // Token het han (vd. phien vua duoc cap lai o tab khac): lay token moi, thu lai mot lan.
  if (res.status === 403 && !retried) {
    await refreshCsrf();
    return send(method, path, data, true);
  }
  const body = await parse(res);
  if (body?.csrfToken) csrfToken = body.csrfToken;
  return body;
}

export const post = (path, data) => send('POST', path, data);

export async function login(username, password) {
  await refreshCsrf();
  return post('/auth/login', { username, password });
}

export async function logout() {
  try {
    await post('/auth/logout', {});
  } finally {
    csrfToken = null;
  }
}

export async function currentStaff() {
  try {
    return (await get('/auth/me')).staff;
  } catch (err) {
    if (err.status === 401) return null;
    throw err;
  }
}
