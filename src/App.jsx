import React, { useState, useEffect, useRef } from 'react';
import { Upload, CheckCircle, AlertCircle, RefreshCw, Search, Settings, X, Volume2, Trash2 } from 'lucide-react';
import Scanner from './components/Scanner';
import { parsePDF, extractResi, extractWeights } from './utils/pdfParser';
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
  // ───────────────────────────────────────────────────────────────────

  const [scanning, setScanning] = useState(false);
  const [lastScanned, setLastScanned] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [complete, setComplete] = useState(false);

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
    gain.gain.value = 0.1;
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
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
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
    gain.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 0.05);
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
    gain.gain.setValueAtTime(0.5, ctx.currentTime);
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
    osc.frequency.linearRampToValueAtTime(1800, ctx.currentTime + 0.1); // Coin sweep
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
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
    osc.frequency.exponentialRampToValueAtTime(20, ctx.currentTime + 0.3); // Crunch
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
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
    gain.gain.linearRampToValueAtTime(0.2, ctx.currentTime + 0.1);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.4);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  };
  const playErrorSoft = (ctx) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine"; // Softer than saw/square
    osc.frequency.setValueAtTime(120, ctx.currentTime);
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
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
    // Tremolo effect simulation
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.setValueAtTime(0, ctx.currentTime + 0.05);
    gain.gain.setValueAtTime(0.1, ctx.currentTime + 0.1);
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
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
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

        // --- Weight Logic ---
        // We need to re-extract weights from the FULL combined text of this batch to be safe, 
        // or we accumulate from the loop. 
        // Actually, let's extract from the allText we just built.
        const foundWeights = extractWeights(allText);

        setWeightStats(prev => {
          const newStats = { ...prev };
          foundWeights.forEach(w => {
            newStats[w] = (newStats[w] || 0) + 1;
          });
          return newStats;
        });

        // Merge with existing orders, avoiding duplicates for the main list
        const uniqueIds = [...new Set(allIds)];

        setOrders(prevOrders => {
          const existingIds = new Set(prevOrders.map(o => o.id));
          const newOrders = uniqueIds
            .filter(id => !existingIds.has(id))
            .map(id => ({ id, scanned: false }));

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

  const handleScan = (code) => {
    // Basic normalization: remove whitespace
    const cleanCode = code.trim();

    // Check if code exists in orders
    const index = orders.findIndex(o => o.id === cleanCode);

    if (index !== -1) {
      if (orders[index].scanned) {
        // Already scanned
        playError();
        setLastScanned(`${cleanCode} (Already Scanned)`);
      } else {
        // Success
        playSuccess();
        const newOrders = [...orders];
        newOrders[index].scanned = true;
        setOrders(newOrders);
        setLastScanned(`${cleanCode} - Checked!`);
        setErrorMsg("");
      }
    } else {
      // Not found
      playError();
      setErrorMsg(`Code ${cleanCode} not found in list.`);
      setLastScanned(null);
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
        {(duplicates.length > 0 || Object.keys(weightStats).length > 0) && (
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

                {/* Weight Stats */}
                {Object.keys(weightStats).length > 0 && (
                  <div>
                    <h4 style={{ color: '#0f172a', marginBottom: '0.5rem' }}>Product Quantity by Size:</h4>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: '0.5rem' }}>
                      {Object.entries(weightStats).map(([weight, count]) => (
                        <div key={weight} style={{
                          padding: '0.5rem',
                          background: '#f1f5f9',
                          borderRadius: '0.25rem',
                          textAlign: 'center'
                        }}>
                          <div style={{ fontWeight: 'bold', fontSize: '1.1rem' }}>{count}</div>
                          <div style={{ fontSize: '0.8rem', color: '#64748b', textTransform: 'uppercase' }}>{weight}</div>
                        </div>
                      ))}
                    </div>
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
                setComplete(false);
                setLastScanned(null);
                setExtractedText("");
                setErrorMsg("");
                // Hapus dari localStorage
                localStorage.removeItem('resi_orders');
                localStorage.removeItem('resi_duplicates');
                localStorage.removeItem('resi_weightStats');
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

              <div className="setting-group">
                <label>Test Audio</label>
                <div className="action-row">
                  <button className="test-btn success" onClick={playSuccess}>
                    <Volume2 size={16} /> Test Success
                  </button>
                  <button className="test-btn error" onClick={playError}>
                    <Volume2 size={16} /> Test Error
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
