import { useCallback, useEffect, useState } from 'react';
import Icon from '../components/Icon.jsx';
import Drawer from '../components/Drawer.jsx';
import { get, post } from '../api.js';
import { branchName, formatDateTime, text } from '../lib/format.js';

const PAGE_SIZE = 50;

// Moi du lieu tu API hien thi bang text node cua React (tu escape) - khong
// dung dangerouslySetInnerHTML o bat ky dau.

function CustomerDetail({ id, onClose, onUnauthorized }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    get(`/customers/${encodeURIComponent(id)}`)
      .then((r) => setData(r.customer))
      .catch((err) => {
        if (err.status === 401) onUnauthorized();
        setError(err.status === 404 ? 'Không tìm thấy khách hàng.' : err.message);
      });
  }, [id, onUnauthorized]);

  return (
    <Drawer title={data ? text(data.full_name) : `Khách hàng #${id}`} subtitle={`Mã khách hàng ${id}`} onClose={onClose}>
      {error && <div className="alert alert-error"><Icon name="alert" size={16} /><span>{error}</span></div>}
      {!data && !error && <div className="spinner" />}
      {data && (
        <>
          <dl className="kv-list">
            <div className="kv"><dt>Họ tên</dt><dd>{text(data.full_name)}</dd></div>
            <div className="kv"><dt>Số CCCD</dt><dd className="mono">{text(data.cccd)}</dd></div>
            <div className="kv"><dt>Điện thoại</dt><dd>{text(data.phone)}</dd></div>
            <div className="kv"><dt>Email</dt><dd>{text(data.email)}</dd></div>
            <div className="kv"><dt>Chi nhánh</dt><dd>{branchName(data.branch_id)}</dd></div>
            <div className="kv"><dt>Ngày tạo</dt><dd>{formatDateTime(data.created_at)}</dd></div>
          </dl>
          <div className="alert alert-info">
            <Icon name="lock" size={16} />
            <span>CCCD lưu mã hóa trong cơ sở dữ liệu, chỉ được giải mã khi mở hồ sơ này.</span>
          </div>
        </>
      )}
    </Drawer>
  );
}

function NewCustomer({ onClose, onCreated, onUnauthorized }) {
  const [form, setForm] = useState({ full_name: '', phone: '', email: '', cccd: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v.trim() || undefined]));
      const r = await post('/customers', body);
      onCreated(r.customer);
    } catch (err) {
      if (err.status === 401) onUnauthorized();
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer title="Thêm khách hàng" subtitle="Khách hàng được gắn vào chi nhánh của bạn" onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <label className="field"><span>Họ tên *</span><input value={form.full_name} onChange={set('full_name')} required maxLength={200} autoFocus /></label>
        <label className="field"><span>Số CCCD</span><input value={form.cccd} onChange={set('cccd')} inputMode="numeric" maxLength={20} /></label>
        <label className="field"><span>Điện thoại</span><input value={form.phone} onChange={set('phone')} inputMode="tel" maxLength={20} /></label>
        <label className="field"><span>Email</span><input type="email" value={form.email} onChange={set('email')} maxLength={200} /></label>
        {error && <div className="alert alert-error"><Icon name="alert" size={16} /><span>{error}</span></div>}
        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Hủy</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Đang lưu…' : 'Lưu khách hàng'}</button>
        </div>
      </form>
    </Drawer>
  );
}

export default function Customers({ onUnauthorized }) {
  const [rows, setRows] = useState([]);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState('');
  const [activeSearch, setActiveSearch] = useState(null);   // null = dang xem danh sach
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(async (opts) => {
    setLoading(true);
    setError('');
    try {
      const r = opts.search != null
        ? await get(`/customers/search?name=${encodeURIComponent(opts.search)}`)
        : await get(`/customers?limit=${PAGE_SIZE}&offset=${opts.offset}`);
      setRows(r.customers || []);
    } catch (err) {
      if (err.status === 401) onUnauthorized();
      setError(err.message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [onUnauthorized]);

  useEffect(() => {
    load(activeSearch != null ? { search: activeSearch } : { offset });
  }, [load, offset, activeSearch]);

  const doSearch = (e) => {
    e.preventDefault();
    const q = query.trim();
    setActiveSearch(q ? q : null);
    if (!q) setOffset(0);
  };

  const clearSearch = () => {
    setQuery('');
    setActiveSearch(null);
    setOffset(0);
  };

  return (
    <>
      <section className="card">
        <header className="card-head">
          <div>
            <h2>Khách hàng</h2>
            <p className="sub">Chỉ hiện khách hàng thuộc chi nhánh của bạn</p>
          </div>
          <div className="card-actions">
            <form className="search" onSubmit={doSearch} role="search">
              <Icon name="search" size={16} />
              <input className="search-input" placeholder="Tìm theo tên…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Tìm khách hàng theo tên" />
              <button type="submit" className="btn btn-sm">Tìm</button>
            </form>
            <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
              <Icon name="user" size={16} /> Thêm khách hàng
            </button>
          </div>
        </header>

        {notice && <div className="card-body"><div className="alert alert-info"><Icon name="check" size={16} /><span>{notice}</span></div></div>}
        {activeSearch != null && (
          <div className="card-body search-state">
            Kết quả tìm “<strong>{activeSearch}</strong>”: {rows.length} khách hàng
            <button type="button" className="btn btn-sm btn-ghost" onClick={clearSearch}><Icon name="x" size={14} /> Bỏ tìm</button>
          </div>
        )}
        {error && <div className="card-body"><div className="alert alert-error"><Icon name="alert" size={16} /><span>{error}</span></div></div>}

        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th className="num">Mã</th>
                <th>Họ tên</th>
                <th>Điện thoại</th>
                <th className="hide-sm">Email</th>
                <th className="hide-sm">Chi nhánh</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c, i) => (
                <tr key={`${c.id}-${i}`} className="clickable" tabIndex={0} onClick={() => setOpenId(c.id)}
                    onKeyDown={(e) => e.key === 'Enter' && setOpenId(c.id)}>
                  <td className="num mono">{text(c.id)}</td>
                  <td>{text(c.full_name)}</td>
                  <td>{text(c.phone)}</td>
                  <td className="hide-sm">{text(c.email)}</td>
                  <td className="hide-sm">{branchName(c.branch_id)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading && <div className="empty"><div className="spinner" style={{ margin: '0 auto' }} /></div>}
          {!loading && rows.length === 0 && !error && <div className="empty">Không có khách hàng nào.</div>}
        </div>

        {activeSearch == null && (
          <footer className="pager">
            <span>Từ {offset + 1} đến {offset + rows.length}</span>
            <span className="pager-spacer" />
            <button type="button" className="btn btn-sm" disabled={offset === 0 || loading} onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}>Trước</button>
            <button type="button" className="btn btn-sm" disabled={rows.length < PAGE_SIZE || loading} onClick={() => setOffset((o) => o + PAGE_SIZE)}>Sau</button>
          </footer>
        )}
      </section>

      {openId != null && <CustomerDetail id={openId} onClose={() => setOpenId(null)} onUnauthorized={onUnauthorized} />}
      {creating && (
        <NewCustomer
          onClose={() => setCreating(false)}
          onUnauthorized={onUnauthorized}
          onCreated={(c) => {
            setCreating(false);
            setNotice(`Đã thêm khách hàng “${text(c.full_name)}” (mã ${text(c.id)}).`);
            clearSearch();
          }}
        />
      )}
    </>
  );
}
