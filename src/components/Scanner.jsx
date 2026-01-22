import React, { useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { RefreshCw } from 'lucide-react';

const Scanner = ({ onScan }) => {
    const scannerId = "reader";
    const scannerRef = useRef(null);
    const [torchOn, setTorchOn] = useState(false);
    const [hasTorch, setHasTorch] = useState(false);

    // Cooldown Ref
    const lastScanTimeRef = useRef(0);
    const onScanRef = useRef(onScan);

    useEffect(() => {
        onScanRef.current = onScan;
    }, [onScan]);

    useEffect(() => {
        const html5QrCode = new Html5Qrcode(scannerId);
        scannerRef.current = html5QrCode;

        const config = {
            fps: 10,
            qrbox: { width: 250, height: 250 },
            aspectRatio: 1.0
        };

        const startScanner = async () => {
            try {
                await html5QrCode.start(
                    { facingMode: "environment" },
                    config,
                    (decodedText, decodedResult) => {
                        const now = Date.now();
                        if (now - lastScanTimeRef.current < 3000) {
                            return;
                        }
                        if (onScanRef.current) {
                            lastScanTimeRef.current = now;
                            onScanRef.current(decodedText);
                        }
                    },
                    (errorMessage) => {
                        // quiet
                    }
                );

                // Check for Torch capability
                // We need to wait a bit or check the running track
                // Note: html5-qrcode doesn't expose track easily in all versions, 
                // but we can try applying constraints if needed.
                // For now, let's assume if it started, we might check capabilities if the library exposes getRunningTrackCameraCapabilities 
                // or just rely on applyVideoConstraints catching errors.
                setHasTorch(true); // Optimistically show torch button, or logic to detect
            } catch (err) {
                console.error("Error starting scanner", err);
            }
        };

        startScanner();

        return () => {
            if (scannerRef.current) {
                scannerRef.current.stop().then(() => {
                    scannerRef.current.clear();
                }).catch(err => {
                    console.error("Failed to stop scanner", err);
                });
            }
        };
    }, []);

    const toggleTorch = async () => {
        if (!scannerRef.current) return;
        try {
            await scannerRef.current.applyVideoConstraints({
                advanced: [{ torch: !torchOn }]
            });
            setTorchOn(!torchOn);
        } catch (err) {
            console.error("Torch not supported or failed", err);
            setHasTorch(false); // Hide button if failed
        }
    };

    return (
        <div className="scanner-wrapper">
            <div id={scannerId} style={{ width: '100%', overflow: 'hidden', borderRadius: '0.75rem' }}></div>

            {/* Custom Torch Button - Only show if we think we might have torch */}
            <div style={{ marginTop: '1rem', display: 'flex', justifyContent: 'center' }}>
                <button
                    onClick={toggleTorch}
                    type="button"
                    style={{
                        padding: '0.75rem 1.5rem',
                        borderRadius: '9999px',
                        border: 'none',
                        backgroundColor: torchOn ? '#fbbf24' : '#f1f5f9',
                        color: torchOn ? '#000' : '#64748b',
                        fontWeight: 600,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        boxShadow: '0 2px 5px rgba(0,0,0,0.1)'
                    }}
                >
                    {torchOn ? 'Turn Off Flash' : 'Turn On Flash'}
                </button>
            </div>
        </div>
    );
};

export default Scanner;
