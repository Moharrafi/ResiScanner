import React, { useState, useEffect, useRef } from 'react';
import { Upload, CheckCircle, AlertCircle, RefreshCw, Search, Settings, X, Volume2, Trash2, History } from 'lucide-react';
import Scanner from './components/Scanner';
import { parsePDF, extractResi, extractWeights, extractProductName } from './utils/pdfParser';
import './App.css';

function App() {
  // ── Persistent state: load from localStorage on init ──────────────
  const [orders, setOrders] = useState(() => {
    try { return JSON.parse(localStorage.getItem('resi_orders') || '[]'); }
    catch { return []; }
  });
  const [duplicates, setDuplicates] = useState(() => {
    try { return JSON.parse(localStorage.getItem('resi_duplicates') || '[]'); }
    catch { return []; }
  });
  const [weightStats, setWeightStats] = useState(() => {
    try { return JSON.parse(localStorage.getItem('resi_weightStats') || '{}'); }
    catch { return {}; }
  });
  const [productStats, setProductStats] = useState(() => {
    try { return JSON.parse(localStorage.getItem('resi_productStats') || '{"bitumax":{},"biasa":{}}'); }
    catch { return { bitumax: {}, biasa: {} }; }
  });
  // ───────────────────────────────────────────────────────────────────

  const [scanHistory, setScanHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem('resi_scanHistory') || '[]'); }
    catch { return []; }
  });
  const [showHistory, setShowHistory] = useState(false);

  const [scanning, setScanning] = useState(false);
  const [lastScanned, setLastScanned] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [complete, setComplete] = useState(false);
  const [androidLoading, setAndroidLoading] = useState(false);

  const [extractedText, setExtractedText] = useState("");
  const [showDebug, setShowDebug] = useState(false);
  const [showScanner, setShowScanner] = useState(false);

  // OCR State
  const [ocrProgress, setOcrProgress] = useState(null); // null | { current, total }

  // Settings State
  const [showSettings, setShowSettings] = useState(false);
  const [soundTheme, setSoundTheme] = useState(() => {
    return localStorage.getItem('soundTheme') || 'modern';
  });

  const [showAnalysis, setShowAnalysis] = useState(false);

  // ── Persist to localStorage whenever state changes ─────────────────
  useEffect(() => { localStorage.setItem('soundTheme', soundTheme); }, [soundTheme]);
  useEffect(() => { localStorage.setItem('resi_orders', JSON.stringify(orders)); }, [orders]);
  useEffect(() => { localStorage.setItem('resi_duplicates', JSON.stringify(duplicates)); }, [duplicates]);
  useEffect(() => { localStorage.setItem('resi_weightStats', JSON.stringify(weightStats)); }, [weightStats]);
  useEffect(() => { localStorage.setItem('resi_productStats', JSON.stringify(productStats)); }, [productStats]);
  useEffect(() => { localStorage.setItem('resi_scanHistory', JSON.stringify(scanHistory)); }, [scanHistory]);
  // ────────────────────────────────────────────────────────────────────

  // --- AUDIO LOGIC ---

  // 1. Classic (Beep/Buzz)
  const playSuccessClassic = (ctx) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 1000;
    osc.type = "sine";
    gain.gain.value = 0.4;
    osc.start();
    osc.stop(ctx.currentTime + 0.1);
  };
  const playErrorClassic = (ctx) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 200;
    osc.type = "sawtooth";
    gain.gain.setValueAtTime(0.6, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.01, ctx.currentTime + 0.3);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
  };

  // 2. Modern (Chime/Bonk)
  const playSuccessModern = (ctx) => {
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();
    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);
    osc1.frequency.setValueAtTime(523.25, ctx.currentTime);
    osc1.type = "sine";
    osc2.frequency.setValueAtTime(659.25, ctx.currentTime);
    osc2.type = "sine";
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(1.0, ctx.currentTime + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
    osc1.start(); osc2.start();
    osc1.stop(ctx.currentTime + 0.5); osc2.stop(ctx.currentTime + 0.5);
  };
  const playErrorModern = (ctx) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "triangle";
    osc.frequency.setValueAtTime(150, ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(50, ctx.currentTime + 0.3);
    gain.gain.setValueAtTime(1.0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.01, ctx.currentTime + 0.3);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
  };

  // 3. Arcade (8-bit Coin / Explosion)
  const playSuccessArcade = (ctx) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "square";
    osc.frequency.setValueAtTime(900, ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(1800, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.4, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.2);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
  };
  const playErrorArcade = (ctx) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "square";
    osc.frequency.setValueAtTime(150, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(20, ctx.currentTime + 0.3);
    gain.gain.setValueAtTime(0.6, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.3);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
  };

  // 4. Soft (Gentle Sine / Low Hum)
  const playSuccessSoft = (ctx) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(440, ctx.currentTime);
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.6, ctx.currentTime + 0.1);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.4);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  };
  const playErrorSoft = (ctx) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(120, ctx.currentTime);
    gain.gain.setValueAtTime(0.6, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.4);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  };

  // 5. Robot (Metallic)
  const playSuccessRobot = (ctx) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    gain.gain.setValueAtTime(0.4, ctx.currentTime);
    gain.gain.setValueAtTime(0, ctx.currentTime + 0.05);
    gain.gain.setValueAtTime(0.4, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0, ctx.currentTime + 0.15);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
  };
  const playErrorRobot = (ctx) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(80, ctx.currentTime);
    gain.gain.setValueAtTime(0.8, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
  };

  // Main Audio Dispatchers
  const playSuccess = () => {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    switch (soundTheme) {
      case 'arcade': playSuccessArcade(ctx); break;
      case 'soft': playSuccessSoft(ctx); break;
      case 'robot': playSuccessRobot(ctx); break;
      case 'classic': playSuccessClassic(ctx); break;
      case 'modern': default: playSuccessModern(ctx); break;
    }
  };

  const playError = () => {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    switch (soundTheme) {
      case 'arcade': playErrorArcade(ctx); break;
      case 'soft': playErrorSoft(ctx); break;
      case 'robot': playErrorRobot(ctx); break;
      case 'classic': playErrorClassic(ctx); break;
      case 'modern': default: playErrorModern(ctx); break;
    }
  };

  // Audio for "Complete" - TTS
  const playComplete = () => {
    if ('speechSynthesis' in window) {
      const msg = new SpeechSynthesisUtterance("Sudah lengkap");
      msg.lang = "id-ID";
      window.speechSynthesis.speak(msg);
    }
  };

  const processFiles = async (files) => {
    if (!files || files.length === 0) return;

    try {
      let allText = "";
      let allIds = [];
      let errorCount = 0;

      // Process all files
      for (let i = 0; i < files.length; i++) {
        try {
          const text = await parsePDF(files[i], (current, total, status) => {
            if (status === 'done') {
              setOcrProgress(null);
            } else {
              setOcrProgress({ current, total, fileIndex: i + 1, totalFiles: files.length });
            }
          });
          setOcrProgress(null);
          allText += `\n--- File ${i + 1} ---\n` + text;
          const extractedIds = extractResi(text);
          allIds = [...allIds, ...extractedIds];
        } catch (err) {
          console.error(`Error parsing file ${i}:`, err);
          errorCount++;
        }
      }

      setExtractedText(prev => prev + allText); // Append to debug text

      if (allIds.length > 0) {
        // --- Duplicate Logic ---
        // 1. Duplicates within current batch
        const batchDuplicates = allIds.filter((item, index) => allIds.indexOf(item) !== index);

        // 2. Duplicates against existing orders
        const existingIdsSet = new Set(orders.map(o => o.id));
        const alreadyInSystem = allIds.filter(id => existingIdsSet.has(id));

        const newDuplicates = [...new Set([...batchDuplicates, ...alreadyInSystem])];
        if (newDuplicates.length > 0) {
          setDuplicates(prev => [...new Set([...prev, ...newDuplicates])]);
        }

        // --- Weight Logic + Product Type per Size ---
        // Build detailed stats
        const foundProducts = extractProductName(allText);

        setWeightStats(prev => {
          const newStats = { ...prev };
          foundProducts.forEach(({ resiWeight, items }) => {
            const bItems = items.filter(i => i.type === 'bitumax');
            const sItems = items.filter(i => i.type === 'biasa');

            // Generate breakdown: e.g., "5B+5" for 5kg Bitumax + 5kg Biasa
            const parts = [];
            bItems.forEach(item => {
              const s = item.size.replace(/kg|liter|l/gi, '');
              const q = item.qty || 1;
              parts.push(q > 1 ? `${s}B*${q}` : `${s}B`);
            });
            sItems.forEach(item => {
              const s = item.size.replace(/kg|liter|l/gi, '');
              const q = item.qty || 1;
              parts.push(q > 1 ? `${s}*${q}` : `${s}`);
            });
            const breakdown = parts.join('+');
            // Show breakdown in parentheses only if there are multiple item lines
            const label = (breakdown && items.length > 1) ? `${resiWeight} (${breakdown})` : resiWeight;

            if (!newStats[label]) newStats[label] = { total: 0, bitumax: 0, biasa: 0 };
            if (typeof newStats[label] === 'number') {
              newStats[label] = { total: newStats[label], bitumax: 0, biasa: 0 };
            }
            newStats[label].total += 1;
            newStats[label].bitumax += bItems.reduce((acc, curr) => acc + (curr.qty || 1), 0);
            newStats[label].biasa += sItems.reduce((acc, curr) => acc + (curr.qty || 1), 0);
          });

          // Also handle standalone weights if no product data was matched for some reason
          // But usually foundProducts covers all blocks with weights.
          return newStats;
        });

        // --- Product Type Stats ---
        if (foundProducts.length > 0) {
          setProductStats(prev => {
            const newStats = {
              bitumax: { ...(prev.bitumax || {}) },
              biasa: { ...(prev.biasa || {}) }
            };
            foundProducts.forEach(({ items }) => {
              items.forEach(item => {
                const label = item.size;
                const qty = item.qty || 1;
                if (item.type === 'bitumax') {
                  newStats.bitumax[label] = (newStats.bitumax[label] || 0) + qty;
                } else {
                  newStats.biasa[label] = (newStats.biasa[label] || 0) + qty;
                }
              });
            });
            return newStats;
          });
        }

        // 3. Create a weight map from found products (with breakdown if multiple items)
        const weightMap = {};
        foundProducts.forEach(fp => {
          if (!fp.orderIds || fp.orderIds.length === 0) return;

          // Build breakdown string (e.g. "5B+5") only if multiple item lines
          let label = fp.resiWeight;
          if (fp.items && fp.items.length > 1) {
            const parts = [];
            fp.items.filter(i => i.type === 'bitumax').forEach(item => {
              const s = item.size.replace(/kg|liter|l/gi, '');
              const q = item.qty || 1;
              parts.push(q > 1 ? `${s}B*${q}` : `${s}B`);
            });
            fp.items.filter(i => i.type === 'biasa').forEach(item => {
              const s = item.size.replace(/kg|liter|l/gi, '');
              const q = item.qty || 1;
              parts.push(q > 1 ? `${s}*${q}` : `${s}`);
            });
            const breakdown = parts.join('+');
            if (breakdown) label = `${fp.resiWeight} (${breakdown})`;
          }

          fp.orderIds.forEach(id => {
            weightMap[id] = label;
          });
        });

        // Merge with existing orders, avoiding duplicates for the main list
        const uniqueIds = [...new Set(allIds)];

        setOrders(prevOrders => {
          const existingIds = new Set(prevOrders.map(o => o.id));
          const newOrders = uniqueIds
            .filter(id => !existingIds.has(id))
            .map(id => ({
              id,
              scanned: false,
              weight: weightMap[id] || "1kg" // Default to 1kg if missing
            }));

          return [...prevOrders, ...newOrders];
        });

        setComplete(false);
        setErrorMsg("");

        // Feedback based on results
        if (errorCount > 0) {
          setErrorMsg(`Processed with errors. ${errorCount} file(s) failed.`);
          playError();
        } else {
          // Optional: play success sound?
        }
      } else {
        if (errorCount === files.length) {
          setErrorMsg("Failed to parse all uploaded files.");
          playError();
        } else {
          setErrorMsg("No order IDs found in uploaded PDF(s).");
          playError();
        }
      }
    } catch (err) {
      console.error(err);
      setErrorMsg("Critical error processing files.");
      playError();
    }
  };

  const handleFileUpload = async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    await processFiles(files);
    // Reset input so same files can be selected again if needed
    e.target.value = '';
  };

  // Handle Shared File (PWA Share Target)
  useEffect(() => {
    const checkSharedFile = async () => {
      const params = new URLSearchParams(window.location.search);
      if (params.get('shared') === 'true') {
        try {
          const cache = await caches.open('share-target');

          // Read how many files were shared
          const countRes = await cache.match('/shared-file-count');
          if (!countRes) return;
          const count = parseInt(await countRes.text()) || 0;

          if (count > 0) {
            const files = [];
            for (let i = 0; i < count; i++) {
              const res = await cache.match(`/shared-file-${i}`);
              if (res) {
                const blob = await res.blob();
                files.push(new File([blob], `shared-receipt-${i + 1}.pdf`, { type: 'application/pdf' }));
              }
            }

            if (files.length > 0) {
              await processFiles(files);
            }

            // Cleanup all cached entries
            await cache.delete('/shared-file-count');
            for (let i = 0; i < count; i++) {
              await cache.delete(`/shared-file-${i}`);
            }
          }

          // Remove query param without reload
          window.history.replaceState({}, document.title, window.location.pathname);
        } catch (err) {
          console.error('Error retrieving shared file:', err);
          setErrorMsg('Error loading shared file.');
        }
      }
    };

    checkSharedFile();
  }, []);

  // Handle Android VIEW Intent (PDF opened from file manager / other apps)
  useEffect(() => {
    const handleAndroidPdf = async (base64, filename) => {
      try {
        setAndroidLoading(false); // loading sudah ditangani oleh ocrProgress
        const byteChars = atob(base64);
        const byteNums = new Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) {
          byteNums[i] = byteChars.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNums);
        const blob = new Blob([byteArray], { type: 'application/pdf' });
        const file = new File([blob], filename || 'intent.pdf', { type: 'application/pdf' });
        await processFiles([file]);
      } catch (err) {
        console.error('Error processing Android intent PDF:', err);
        setErrorMsg('Gagal membuka file dari intent Android.');
      } finally {
        setAndroidLoading(false);
      }
    };

    // Register global loading control functions (called from MainActivity)
    window.showPdfLoading = () => setAndroidLoading(true);
    window.hidePdfLoading = () => setAndroidLoading(false);
    window.onAndroidPdfIntent = handleAndroidPdf;

    // Handle if intent arrived before React was ready
    if (window._pendingAndroidPdf) {
      const { base64, filename } = window._pendingAndroidPdf;
      window._pendingAndroidPdf = null;
      handleAndroidPdf(base64, filename);
    }

    return () => {
      window.onAndroidPdfIntent = null;
      window.showPdfLoading = null;
      window.hidePdfLoading = null;
    };
  }, []);

  const handleScan = (code) => {
    // Basic normalization: remove whitespace
    const cleanCode = code.trim();
    const timestamp = new Date().toISOString();

    // Check if code exists in orders
    const index = orders.findIndex(o => o.id === cleanCode);

    if (index !== -1) {
      if (orders[index].scanned) {
        // Already scanned
        playError();
        const weightText = orders[index].weight ? ` (${orders[index].weight})` : "";
        setLastScanned(`${cleanCode}${weightText} (Already Scanned)`);
        setScanHistory(prev => [{ id: cleanCode, timestamp, status: 'duplicate' }, ...prev]);
      } else {
        // Success
        playSuccess();
        const newOrders = [...orders];
        newOrders[index].scanned = true;
        setOrders(newOrders);
        const weightText = orders[index].weight ? ` (${orders[index].weight})` : "";
        setLastScanned(`${cleanCode}${weightText} - Checked!`);
        setErrorMsg("");
        setScanHistory(prev => [{ id: cleanCode, timestamp, status: 'success' }, ...prev]);
      }
    } else {
      // Not found
      playError();
      setErrorMsg(`Code ${cleanCode} not found in list.`);
      setLastScanned(null);
      setScanHistory(prev => [{ id: cleanCode, timestamp, status: 'not_found' }, ...prev]);
    }
  };

  // Check completion
  useEffect(() => {
    if (orders.length > 0 && orders.every(o => o.scanned) && !complete) {
      setComplete(true);
      playComplete();
    }
  }, [orders, complete]);

  const counts = {
    total: orders.length,
    scanned: orders.filter(o => o.scanned).length
  };

  return (
    <div className="container">
      {/* Android PDF Loading Overlay */}
      {androidLoading && (
        <div className="android-loading-overlay">
          <div className="android-loading-box">
            <div className="android-spinner" />
            <p>Memuat PDF...</p>
          </div>
        </div>
      )}

      <header className="app-header">
        <div className="header-top">
          <div className="header-title">
            <h1>Resi Scanner</h1>
            <span className="badge">v1.2</span>
          </div>
          <button
            className="btn-icon"
            onClick={() => setShowSettings(true)}
            aria-label="Settings"
          >
            <Settings size={22} color="#1e293b" />
          </button>
        </div>

        {orders.length > 0 && (
          <div className="progress-bar-container">
            <div className="progress-info">
              <span>Progress</span>
              <span className="progress-count">{counts.scanned} / {counts.total}</span>
            </div>
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{ width: `${(counts.scanned / counts.total) * 100}%` }}
              ></div>
            </div>
          </div>
        )}
      </header>

      <main>
        {/* Analysis / Report Section */}
        {(orders.length > 0 || duplicates.length > 0 || Object.keys(weightStats).length > 0 || (productStats.bitumax && Object.keys(productStats.bitumax).length > 0) || (productStats.biasa && Object.keys(productStats.biasa).length > 0)) && (
          <div className="analysis-section" style={{ marginBottom: '1rem' }}>
            <button
              onClick={() => setShowAnalysis(!showAnalysis)}
              style={{
                width: '100%',
                padding: '0.75rem',
                background: '#f8fafc',
                border: '1px solid #e2e8f0',
                borderRadius: '0.5rem',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                cursor: 'pointer',
                fontWeight: 600,
                color: '#334155'
              }}
            >
              <span>📊 Analysis Report</span>
              <span>{showAnalysis ? '▲' : '▼'}</span>
            </button>

            {showAnalysis && (
              <div style={{
                padding: '1rem',
                border: '1px solid #e2e8f0',
                borderTop: 'none',
                borderBottomLeftRadius: '0.5rem',
                borderBottomRightRadius: '0.5rem',
                background: '#fff'
              }}>
                {/* Duplicates */}
                {duplicates.length > 0 && (
                  <div style={{ marginBottom: '1rem' }}>
                    <h4 style={{ color: '#dc2626', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <AlertCircle size={16} /> Duplicate Resi Detected:
                    </h4>
                    <div style={{ maxHeight: '100px', overflowY: 'auto', background: '#fef2f2', padding: '0.5rem', borderRadius: '0.25rem', fontSize: '0.85rem' }}>
                      {duplicates.map(d => (
                        <div key={d}>{d}</div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Weight Stats with Bitumax/Biasa breakdown */}
                {Object.keys(weightStats).length > 0 && (
                  <div>
                    <h4 style={{ color: '#0f172a', marginBottom: '0.5rem' }}>Product Quantity by Size:</h4>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '0.5rem' }}>
                      {Object.entries(weightStats).map(([weight, data]) => {
                        // Support legacy format (number) and new format (object)
                        const total = typeof data === 'number' ? data : data.total;
                        const bitumax = typeof data === 'number' ? 0 : (data.bitumax || 0);
                        const biasa = typeof data === 'number' ? 0 : (data.biasa || 0);
                        const hasBitumax = bitumax > 0;
                        const hasBiasa = biasa > 0;
                        return (
                          <div key={weight} style={{
                            padding: '0.5rem',
                            background: hasBitumax && !hasBiasa ? '#fffbeb' : hasBiasa && !hasBitumax ? '#eff6ff' : '#f1f5f9',
                            border: hasBitumax && !hasBiasa ? '1px solid #fbbf24' : hasBiasa && !hasBitumax ? '1px solid #93c5fd' : '1px solid #e2e8f0',
                            borderRadius: '0.35rem',
                            textAlign: 'center'
                          }}>
                            <div style={{ fontWeight: 'bold', fontSize: '1.1rem' }}>{total}</div>
                            <div style={{ fontSize: '0.8rem', color: '#64748b', textTransform: 'uppercase', marginBottom: hasBitumax || hasBiasa ? '0.3rem' : 0 }}>{weight}</div>
                            {(hasBitumax || hasBiasa) && (
                              <div style={{ display: 'flex', justifyContent: 'center', gap: '0.3rem', flexWrap: 'wrap' }}>
                                {hasBitumax && (
                                  <span style={{
                                    fontSize: '0.65rem', fontWeight: 600,
                                    background: '#fef3c7', color: '#92400e',
                                    padding: '1px 6px', borderRadius: '999px',
                                    border: '1px solid #fbbf24'
                                  }}>🟠 {bitumax}</span>
                                )}
                                {hasBiasa && (
                                  <span style={{
                                    fontSize: '0.65rem', fontWeight: 600,
                                    background: '#dbeafe', color: '#1e40af',
                                    padding: '1px 6px', borderRadius: '999px',
                                    border: '1px solid #93c5fd'
                                  }}>🔵 {biasa}</span>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Product Type Stats: Bitumax vs Biasa */}
                {((productStats.bitumax && Object.keys(productStats.bitumax).length > 0) || (productStats.biasa && Object.keys(productStats.biasa).length > 0)) && (
                  <div style={{ marginTop: '1rem' }}>
                    <h4 style={{ color: '#0f172a', marginBottom: '0.75rem' }}>Produk per Jenis:</h4>

                    {/* Bitumax */}
                    {productStats.bitumax && Object.keys(productStats.bitumax).length > 0 && (
                      <div style={{ marginBottom: '0.75rem' }}>
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: '0.4rem',
                          marginBottom: '0.4rem', fontWeight: 600, color: '#b45309', fontSize: '0.9rem'
                        }}>
                          🟠 Bitumax
                          <span style={{
                            background: '#fef3c7', border: '1px solid #fbbf24',
                            borderRadius: '999px', padding: '0 0.5rem',
                            fontSize: '0.8rem', fontWeight: 700
                          }}>
                            {Object.values(productStats.bitumax).reduce((a, b) => a + b, 0)} pcs
                          </span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))', gap: '0.4rem' }}>
                          {Object.entries(productStats.bitumax).map(([size, count]) => (
                            <div key={size} style={{
                              padding: '0.4rem 0.5rem', background: '#fffbeb',
                              border: '1px solid #fbbf24', borderRadius: '0.35rem', textAlign: 'center'
                            }}>
                              <div style={{ fontWeight: 'bold', fontSize: '1rem', color: '#92400e' }}>{count}</div>
                              <div style={{ fontSize: '0.75rem', color: '#b45309', textTransform: 'uppercase' }}>{size}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Biasa */}
                    {productStats.biasa && Object.keys(productStats.biasa).length > 0 && (
                      <div>
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: '0.4rem',
                          marginBottom: '0.4rem', fontWeight: 600, color: '#1d4ed8', fontSize: '0.9rem'
                        }}>
                          🔵 Biasa
                          <span style={{
                            background: '#eff6ff', border: '1px solid #93c5fd',
                            borderRadius: '999px', padding: '0 0.5rem',
                            fontSize: '0.8rem', fontWeight: 700
                          }}>
                            {Object.values(productStats.biasa).reduce((a, b) => a + b, 0)} pcs
                          </span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))', gap: '0.4rem' }}>
                          {Object.entries(productStats.biasa).map(([size, count]) => (
                            <div key={size} style={{
                              padding: '0.4rem 0.5rem', background: '#eff6ff',
                              border: '1px solid #93c5fd', borderRadius: '0.35rem', textAlign: 'center'
                            }}>
                              <div style={{ fontWeight: 'bold', fontSize: '1rem', color: '#1e40af' }}>{count}</div>
                              <div style={{ fontSize: '0.75rem', color: '#1d4ed8', textTransform: 'uppercase' }}>{size}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Scanner Section */}
        {orders.length > 0 ? (
          <>
            <div className="scanner-section">
              {showScanner ? (
                <>
                  <Scanner onScan={handleScan} />
                  <button
                    onClick={() => setShowScanner(false)}
                    className="toggle-scanner-btn"
                  >
                    STOP SCANNING
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setShowScanner(true)}
                  className="start-scanner-btn"
                >
                  START SCANNING
                </button>
              )}

              {/* Manual Input - Persistent */}
              <form onSubmit={(e) => {
                e.preventDefault();
                const input = e.target.elements.manualInput.value;
                if (input.trim()) {
                  handleScan(input.trim());
                  e.target.reset();
                }
              }} className="manual-input">
                <input
                  name="manualInput"
                  type="text"
                  placeholder="Manual Input (Type Order ID)"
                />
                <button type="submit">
                  <Search size={20} />
                </button>
              </form>
            </div>

            {/* Feedback / Status */}
            {lastScanned && (
              <div className="status-message status-success">
                <CheckCircle size={20} />
                <span>{lastScanned}</span>
              </div>
            )}
            {errorMsg && (
              <div className="status-message status-error">
                <AlertCircle size={20} />
                <span>{errorMsg}</span>
              </div>
            )}

            {/* List */}
            <div className="order-list">
              <div className="list-header">
                Order List
              </div>
              <ul className="list-items">
                {orders.map((order) => (
                  <li key={order.id} className={`list-item ${order.scanned ? 'scanned' : ''}`}>
                    <span>{order.id}</span>
                    {order.scanned && <CheckCircle size={18} color="#16a34a" />}
                  </li>
                ))}
              </ul>
            </div>
          </>
        ) : (
          <div className="empty-state">
            <Upload size={48} style={{ marginBottom: '1rem', opacity: 0.5 }} />
            <p>Upload a PDF to start</p>
          </div>
        )}

        {/* OCR Progress Banner */}
        {ocrProgress && (
          <div style={{
            marginTop: '1rem',
            padding: '0.75rem 1rem',
            background: '#eff6ff',
            border: '1px solid #bfdbfe',
            borderRadius: '0.5rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            fontSize: '0.9rem',
            color: '#1e40af'
          }}>
            <RefreshCw size={18} style={{ animation: 'spin 1.2s linear infinite' }} />
            <span>
              🔍 OCR sedang berjalan...
              {ocrProgress.totalFiles > 1 && ` (File ${ocrProgress.fileIndex}/${ocrProgress.totalFiles})`}
              {` Halaman ${ocrProgress.current}/${ocrProgress.total}`}
            </span>
          </div>
        )}
      </main>

      <footer>
        {orders.length > 0 && (
          <button
            type="button"
            onClick={() => {
              if (window.confirm("Hapus semua resi? Data tidak bisa dikembalikan.")) {
                setOrders([]);
                setDuplicates([]);
                setWeightStats({});
                setProductStats({ bitumax: {}, biasa: {} });
                setScanHistory([]);
                setComplete(false);
                setLastScanned(null);
                setExtractedText("");
                setErrorMsg("");
                // Hapus dari localStorage
                localStorage.removeItem('resi_orders');
                localStorage.removeItem('resi_duplicates');
                localStorage.removeItem('resi_weightStats');
                localStorage.removeItem('resi_productStats');
                localStorage.removeItem('resi_scanHistory');
              }
            }}
            style={{
              marginBottom: '0.5rem',
              color: '#dc2626',
              border: '1px solid #fca5a5',
              background: '#fef2f2',
              padding: '0.5rem 1rem',
              borderRadius: '0.5rem',
              fontSize: '0.85rem',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              width: 'fit-content'
            }}
          >
            <Trash2 size={16} /> Clear List
          </button>
        )}

        {/* Scan History Panel */}
        {scanHistory.length > 0 && (
          <div className="history-section">
            <button
              className="history-toggle-btn"
              onClick={() => setShowHistory(!showHistory)}
            >
              <History size={16} />
              <span>History Scan ({scanHistory.length})</span>
              <span className="history-chevron">{showHistory ? '▲' : '▼'}</span>
            </button>

            {showHistory && (
              <div className="history-list">
                <div className="history-list-header">
                  <span>Riwayat Scan</span>
                  <button
                    className="history-clear-btn"
                    onClick={() => {
                      setScanHistory([]);
                      localStorage.removeItem('resi_scanHistory');
                    }}
                  >
                    <Trash2 size={13} /> Hapus History
                  </button>
                </div>
                <ul className="history-items">
                  {scanHistory.map((entry, i) => (
                    <li key={i} className={`history-item history-${entry.status}`}>
                      <span className={`history-badge badge-${entry.status}`}>
                        {entry.status === 'success' ? '✓' : entry.status === 'duplicate' ? '⟳' : '✗'}
                      </span>
                      <span className="history-id">{entry.id}</span>
                      <span className="history-time">
                        {new Date(entry.timestamp).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <label className="upload-btn">
          Upload PDF
          <input
            type="file"
            accept="application/pdf"
            multiple // Allow multiple files
            onChange={handleFileUpload}
            className="hidden"
          />
        </label>

        {complete && (
          <div className="completion-banner">
            🎉 All Complete!
          </div>
        )}

        <div style={{ marginTop: '20px', display: 'flex', flexDirection: 'column', gap: '1rem', alignItems: 'center' }}>
          <button
            type="button"
            onClick={() => setShowDebug(!showDebug)}
            style={{ fontSize: '0.75rem', color: '#94a3b8', background: 'none', border: 'none', cursor: 'pointer' }}
          >
            {showDebug ? "Hide Debug Info" : "Show Debug Info"}
          </button>
        </div>

        {showDebug && (
          <div className="debug-section">
            <h4>Raw Extracted Text:</h4>
            <pre>{extractedText || "No PDF uploaded yet."}</pre>
          </div>
        )}
      </footer>

      {/* Settings Modal */}
      {showSettings && (
        <div className="settings-overlay" onClick={() => setShowSettings(false)}>
          <div className="settings-modal" onClick={e => e.stopPropagation()}>
            <div className="settings-header">
              <h2>Settings</h2>
              <button className="btn-icon" onClick={() => setShowSettings(false)}>
                <X size={20} />
              </button>
            </div>

            <div className="settings-content">
              <div className="setting-group">
                <label>Audio Theme</label>
                <div className="toggle-group">
                  {['modern', 'classic', 'arcade', 'soft', 'robot'].map(theme => (
                    <button
                      key={theme}
                      className={`toggle-btn ${soundTheme === theme ? 'active' : ''}`}
                      onClick={() => setSoundTheme(theme)}
                    >
                      {theme.charAt(0).toUpperCase() + theme.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="setting-group" style={{ marginTop: '20px', paddingTop: '20px', borderTop: '1px solid #e2e8f0' }}>
                <label style={{ color: '#dc2626' }}>System / Troubleshooting</label>
                <div style={{ marginTop: '10px' }}>
                  <button
                    className="test-btn"
                    style={{ background: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca', width: '100%', justifyContent: 'center' }}
                    onClick={() => {
                      if (window.confirm("Ini akan menghapus semua cache, service worker, dan data lokal, lalu merestart aplikasi. Lanjutkan?")) {
                        // 1. Clear Service Workers
                        if ('serviceWorker' in navigator) {
                          navigator.serviceWorker.getRegistrations().then(regs => {
                            regs.forEach(reg => reg.unregister());
                          });
                        }
                        // 2. Clear Caches
                        if ('caches' in window) {
                          caches.keys().then(names => {
                            names.forEach(name => caches.delete(name));
                          });
                        }
                        // 3. Clear LocalStorage
                        localStorage.clear();
                        // 4. Force Reload
                        window.location.reload(true);
                      }
                    }}
                  >
                    <RefreshCw size={16} /> Force Update / Clear All Cache
                  </button>
                  <p style={{ fontSize: '0.7rem', color: '#64748b', marginTop: '5px' }}>
                    Gunakan jika perubahan fitur tidak muncul atau aplikasi terasa lambat.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <footer style={{ marginTop: '2rem', padding: '1rem', textAlign: 'center', fontSize: '0.8rem', color: '#94a3b8' }}>
        &copy; 2024 Resi Scanner Analysis Tools
        <div style={{ marginTop: '1rem' }}>
          <button
            id="debug-toggle"
            onClick={() => setShowDebug(!showDebug)}
            style={{
              background: 'none',
              border: 'none',
              color: '#94a3b8',
              textDecoration: 'underline',
              cursor: 'pointer',
              fontSize: '0.75rem'
            }}
          >
            {showDebug ? 'Hide Debug Info' : 'Show Debug Info'}
          </button>
        </div>
        {showDebug && (
          <div style={{ marginTop: '1rem', textAlign: 'left', background: '#f1f5f9', padding: '1rem', borderRadius: '0.5rem', border: '1px solid #cbd5e1' }}>
            <h5 style={{ marginBottom: '0.5rem', color: '#475569' }}>Raw Extracted Text:</h5>
            <textarea
              readOnly
              value={extractedText}
              style={{ width: '100%', height: '200px', fontSize: '0.75rem', fontFamily: 'monospace', padding: '0.5rem' }}
            />
            <p style={{ marginTop: '0.5rem', fontSize: '0.7rem' }}>
              Copy this text and send it to support if items are not being detected correctly.
            </p>
          </div>
        )}
      </footer>
    </div>
  );
}

export default App;
