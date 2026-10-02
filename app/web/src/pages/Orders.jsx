import { useCallback, useEffect, useState } from 'react';
import Icon from '../components/Icon.jsx';
import Drawer from '../components/Drawer.jsx';
import { get, post } from '../api.js';
import { ORDER_STATUS, branchName, formatDateTime, formatMoney, text } from '../lib/format.js';

const PAGE_SIZE = 50;

function StatusBadge({ status }) {
  const s = ORDER_STATUS[status];
  return <span className={`badge ${s?.cls ?? ''}`}>{s?.label ?? text(status)}</span>;
}

function OrderDetail({ id, onClose, onUnauthorized }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    get(`/orders/${encodeURIComponent(id)}`)
      .then((r) => setData(r.order))
      .catch((err) => {
        if (err.status === 401) onUnauthorized();
        setError(err.status === 404 ? `Không tìm thấy đơn hàng #${id}.` : err.message);
      });
  }, [id, onUnauthorized]);

  return (
    <Drawer title={data ? text(data.order_no) : `Đơn hàng #${id}`} subtitle={`Mã đơn ${id}`} onClose={onClose}>
      {error && <div className="alert alert-error"><Icon name="alert" size={16} /><span>{error}</span></div>}
      {!data && !error && <div className="spinner" />}
      {data && (
        <dl className="kv-list">
          <div className="kv"><dt>Số đơn</dt><dd className="mono">{text(data.order_no)}</dd></div>
          <div className="kv"><dt>Khách hàng</dt><dd>{text(data.customer_name)} <span className="muted">(mã {text(data.customer_id)})</span></dd></div>
          <div className="kv"><dt>Tổng tiền</dt><dd><strong>{formatMoney(data.total_amount)}</strong></dd></div>
          <div className="kv"><dt>Trạng thái</dt><dd><StatusBadge status={data.status} /></dd></div>
          <div className="kv"><dt>Chi nhánh</dt><dd>{branchName(data.branch_id)}</dd></div>
          <div className="kv"><dt>Ngày tạo</dt><dd>{formatDateTime(data.created_at)}</dd></div>
        </dl>
      )}
    </Drawer>
  );
}

function NewOrder({ onClose, onCreated, onUnauthorized }) {
  const [customerId, setCustomerId] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await post('/orders', { customer_id: Number(customerId), total_amount: Number(amount) });
      onCreated(r.order);
    } catch (err) {
      if (err.status === 401) onUnauthorized();
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer title="Tạo đơn hàng" subtitle="Đơn hàng được gắn vào chi nhánh của bạn" onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <label className="field">
          <span>Mã khách hàng *</span>
          <input type="number" min="1" step="1" value={customerId} onChange={(e) => setCustomerId(e.target.value)} required autoFocus />
        </label>
        <label className="field">
          <span>Tổng tiền (VND) *</span>
          <input type="number" min="0" step="1000" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </label>
        {error && <div className="alert alert-error"><Icon name="alert" size={16} /><span>{error}</span></div>}
        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Hủy</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Đang lưu…' : 'Tạo đơn'}</button>
        </div>
      </form>
    </Drawer>
  );
}

export default function Orders({ onUnauthorized }) {
  const [rows, setRows] = useState([]);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lookup, setLookup] = useState('');
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);

  const load = useCallback(async (off) => {
    setLoading(true);
    setError('');
    try {
      const r = await get(`/orders?limit=${PAGE_SIZE}&offset=${off}`);
      setRows(r.orders || []);
    } catch (err) {
      if (err.status === 401) onUnauthorized();
      setError(err.message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [onUnauthorized]);

  useEffect(() => {
    load(offset);
  }, [load, offset, reload]);

  const openLookup = (e) => {
    e.preventDefault();
    const id = lookup.trim();
    if (/^\d+$/.test(id)) setOpenId(id);
  };

  return (
    <>
      <section className="card">
        <header className="card-head">
          <div>
            <h2>Đơn hàng</h2>
            <p className="sub">Chỉ hiện đơn hàng thuộc chi nhánh của bạn</p>
          </div>
          <div className="card-actions">
            <form className="search" onSubmit={openLookup}>
              <Icon name="search" size={16} />
              <input className="search-input" placeholder="Tra mã đơn…" inputMode="numeric" value={lookup}
                     onChange={(e) => setLookup(e.target.value)} aria-label="Tra đơn hàng theo mã" />
              <button type="submit" className="btn btn-sm">Xem</button>
            </form>
            <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
              <Icon name="archive" size={16} /> Tạo đơn hàng
            </button>
          </div>
        </header>

        {notice && <div className="card-body"><div className="alert alert-info"><Icon name="check" size={16} /><span>{notice}</span></div></div>}
        {error && <div className="card-body"><div className="alert alert-error"><Icon name="alert" size={16} /><span>{error}</span></div></div>}

        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th className="num">Mã</th>
                <th className="hide-sm">Số đơn</th>
                <th>Khách hàng</th>
                <th className="num">Tổng tiền</th>
                <th>Trạng thái</th>
                <th className="hide-sm">Ngày tạo</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id} className="clickable" tabIndex={0} onClick={() => setOpenId(o.id)}
                    onKeyDown={(e) => e.key === 'Enter' && setOpenId(o.id)}>
                  <td className="num mono">{text(o.id)}</td>
                  <td className="mono hide-sm">{text(o.order_no)}</td>
                  <td>{text(o.customer_name)}</td>
                  <td className="num">{formatMoney(o.total_amount)}</td>
                  <td><StatusBadge status={o.status} /></td>
                  <td className="hide-sm">{formatDateTime(o.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading && <div className="empty"><div className="spinner" style={{ margin: '0 auto' }} /></div>}
          {!loading && rows.length === 0 && !error && <div className="empty">Không có đơn hàng nào.</div>}
        </div>

        <footer className="pager">
          <span>Từ {offset + 1} đến {offset + rows.length}</span>
          <span className="pager-spacer" />
          <button type="button" className="btn btn-sm" disabled={offset === 0 || loading} onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}>Trước</button>
          <button type="button" className="btn btn-sm" disabled={rows.length < PAGE_SIZE || loading} onClick={() => setOffset((o) => o + PAGE_SIZE)}>Sau</button>
        </footer>
      </section>

      {openId != null && <OrderDetail id={openId} onClose={() => setOpenId(null)} onUnauthorized={onUnauthorized} />}
      {creating && (
        <NewOrder
          onClose={() => setCreating(false)}
          onUnauthorized={onUnauthorized}
          onCreated={(o) => {
            setCreating(false);
            setNotice(`Đã tạo đơn ${text(o.order_no)} (mã ${text(o.id)}).`);
            setReload((n) => n + 1);
          }}
        />
      )}
    </>
  );
}
