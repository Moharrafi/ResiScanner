import React, { useState, useEffect, useRef } from 'react';
import { Upload, CheckCircle, AlertCircle, RefreshCw, Search, Settings, X, Volume2 } from 'lucide-react';
import Scanner from './components/Scanner';
import { parsePDF, extractResi } from './utils/pdfParser';
import './App.css';

function App() {
  const [orders, setOrders] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [lastScanned, setLastScanned] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [complete, setComplete] = useState(false);

  const [extractedText, setExtractedText] = useState("");
  const [showDebug, setShowDebug] = useState(false);
  const [showScanner, setShowScanner] = useState(false);

  // Settings State
  const [showSettings, setShowSettings] = useState(false);
  const [soundTheme, setSoundTheme] = useState(() => {
    return localStorage.getItem('soundTheme') || 'modern';
  });

  useEffect(() => {
    localStorage.setItem('soundTheme', soundTheme);
  }, [soundTheme]);

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
          const text = await parsePDF(files[i]);
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
        // Merge with existing orders, avoiding duplicates
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
          // Open the specific cache where SW stored the file
          const cache = await caches.open('share-target');
          const response = await cache.match('shared-file');

          if (response) {
            const blob = await response.blob();
            const file = new File([blob], "shared-receipt.pdf", { type: "application/pdf" });

            await processFiles([file]);

            // Cleanup
            await cache.delete('shared-file');
            // Remove query param without reload
            window.history.replaceState({}, document.title, window.location.pathname);
          }
        } catch (err) {
          console.error("Error retrieving shared file:", err);
          setErrorMsg("Error loading shared file.");
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
      </main>

      <footer>
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

        <div style={{ marginTop: '20px', textAlign: 'center' }}>
          <button
            type="button"
            onClick={() => setShowDebug(!showDebug)}
            style={{ fontSize: '0.8rem', color: '#6b7280', textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer' }}
          >
            {showDebug ? "Hide Raw Text" : "Show Raw PDF Text (Debug)"}
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
