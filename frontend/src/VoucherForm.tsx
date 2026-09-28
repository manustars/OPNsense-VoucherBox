import React, { useEffect, useState } from 'react';
import { FaWifi } from 'react-icons/fa';


const MS_PER_HOUR = 60 * 60 * 1000;
const defaultValidity = 4;
const defaultEndDate = new Date(Date.now() + 24 * MS_PER_HOUR);

export default function VoucherForm() {
  const [email, setEmail] = useState('');
  const [validity, setValidity] = useState(defaultValidity);
  const [endDate, setEndDate] = useState(defaultEndDate.toISOString().slice(0, 16));
  const [fetchSuccess, setFetchSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; validity?: string; endDate?: string }>({});
  const [fetchError, setFetchError] = useState(false);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);
  const [voucher, setVoucher] = useState<{ username: string; password: string } | null>(null);
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [emailWarning, setEmailWarning] = useState<string | null>(null);

  useEffect(() => {
    fetch('api/config')
      .then(res => (res.ok ? res.json() : null))
      .then(cfg => setEmailEnabled(Boolean(cfg?.emailEnabled)))
      .catch(() => setEmailEnabled(false));
  }, []);

  function validate() {
    const newErrors: typeof errors = {};
    if (email && !email.match(/^\S+@\S+\.\S+$/)) {
      newErrors.email = 'Please enter a valid email address.';
    }
    if (!validity || validity < 1) {
      newErrors.validity = 'Validity must be at least 1 hour.';
    }
    if (!endDate || isNaN(new Date(endDate).getTime())) {
      newErrors.endDate = 'Please enter a valid end date.';
    } else if (new Date(endDate) < new Date()) {
      newErrors.endDate = 'End date must be in the future.';
    }
    return newErrors;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFetchSuccess(false);
    setFetchError(false);
    setQrCodeDataUrl(null);
    setVoucher(null);
    setEmailWarning(null);
    const validationErrors = validate();
    setErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) return;
    setLoading(true);
    try {
      // validity in seconds, expirytime as Unix timestamp (seconds)
      const validitySeconds = validity * 60 * 60;

      const nowMs = Date.now();
      const endMs = new Date(endDate).getTime();
      const expiryTimestamp = Math.floor((endMs - nowMs) / 1000);

      const res = await fetch('api/createvoucher', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: emailEnabled && email ? email : undefined,
          validity: validitySeconds,
          expirytime: expiryTimestamp,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setFetchSuccess(true);
        setEmail('');
        setValidity(defaultValidity);
        setEndDate(defaultEndDate.toISOString().slice(0, 16));
        if (data.qrCodeDataUrl) {
          setQrCodeDataUrl(data.qrCodeDataUrl);
        }
        if (data.voucher) {
          setVoucher({ username: data.voucher.username, password: data.voucher.password });
        }
        if (emailEnabled && email && !data.emailSent) {
          setEmailWarning('The voucher was created, but the email could not be sent.');
        }
      } else {
        setFetchError(true);
      }
    } catch {
      setFetchError(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-md mx-auto mt-12 p-8 rounded-xl shadow-lg bg-white">
      <div className="flex flex-col items-center mb-2">
        <FaWifi className="text-blue-500 text-4xl mb-2" />
        <h2 className="text-2xl font-bold mb-6 text-center text-gray-800">Create Wifi Voucher</h2>
      </div>
      <form onSubmit={handleSubmit} className="space-y-6">
        {emailEnabled && (<div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Email (optional)</label>
          <input
            type="email"
            className={`w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400 ${errors.email ? 'border-red-500' : 'border-gray-300'}`}
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="user@example.com"
          />
          {errors.email && <p className="text-red-500 text-xs mt-1">{errors.email}</p>}
        </div>)}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Validity (hours)</label>
          <input
            type="number"
            min={1}
            className={`w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400 ${errors.validity ? 'border-red-500' : 'border-gray-300'}`}
            value={validity}
            onChange={e => setValidity(Number(e.target.value))}
            required
          />
          {errors.validity && <p className="text-red-500 text-xs mt-1">{errors.validity}</p>}
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">End Date</label>
          <input
            type="datetime-local"
            className={`w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400 ${errors.endDate ? 'border-red-500' : 'border-gray-300'}`}
            value={endDate}
            onChange={e => setEndDate(e.target.value)}
            required
          />
          {errors.endDate && <p className="text-red-500 text-xs mt-1">{errors.endDate}</p>}
        </div>
        <button
          type="submit"
          disabled={loading}
          className="w-full py-2 text-lg font-semibold rounded-lg bg-blue-500 text-white hover:bg-blue-600 transition disabled:opacity-50"
        >
          {loading ? 'Creating...' : 'Create voucher'}
        </button>
      </form>
      {fetchSuccess && (
        <>
          <div className="mt-6 text-green-600 font-bold text-center text-xl">
            New Voucher created
          </div>
          {voucher && (
            <div className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-lg">
              <span className="text-gray-500">Username</span>
              <span className="font-mono font-bold select-all">{voucher.username}</span>
              <span className="text-gray-500">Password</span>
              <span className="font-mono font-bold select-all">{voucher.password}</span>
            </div>
          )}
          {emailWarning && (
            <div className="mt-2 text-amber-600 text-center text-sm">{emailWarning}</div>
          )}
          {qrCodeDataUrl && (
            <div className="mt-4 flex flex-col items-center">
              <img src={qrCodeDataUrl} alt="Voucher Login QR Code" className="w-40 h-40" />
              <div className="text-xs text-gray-500 mt-2">Join the WIFI first and then scan to login</div>
            </div>
          )}
        </>
      )}
      {fetchError && (
        <div className="mt-6 text-red-600 font-bold text-center text-xl">
          An error occurred
        </div>
      )}
    </div>
  );
}
