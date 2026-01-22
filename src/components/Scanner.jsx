import React, { useEffect, useRef } from 'react';
import { Html5QrcodeScanner } from 'html5-qrcode';

const Scanner = ({ onScan }) => {
    // ID for the container
    const scannerId = "html5qr-code-full-region";
    const scannerRef = useRef(null);
    // Ref to hold the latest callback without triggering re-effects
    const onScanRef = useRef(onScan);

    useEffect(() => {
        onScanRef.current = onScan;
    }, [onScan]);

    // Cooldown Ref
    const lastScanTimeRef = useRef(0);

    useEffect(() => {
        // Prevent double init in Strict Mode
        if (scannerRef.current) return;

        const scanner = new Html5QrcodeScanner(
            scannerId,
            {
                fps: 10,
                qrbox: { width: 250, height: 250 },
                aspectRatio: 1.0,
                showTorchButtonIfSupported: true,
                videoConstraints: {
                    facingMode: "environment"
                }
            },
            /* verbose= */ false
        );

        scannerRef.current = scanner;

        const onScanSuccess = (decodedText, decodedResult) => {
            const now = Date.now();
            // 3000ms delay logic
            if (now - lastScanTimeRef.current < 3000) {
                return; // Ignored (Cooldown)
            }

            if (onScanRef.current) {
                lastScanTimeRef.current = now;
                onScanRef.current(decodedText);
            }
        };

        const onScanFailure = (error) => {
            // quiet
        };

        scanner.render(onScanSuccess, onScanFailure);

        // Cleanup
        return () => {
            if (scannerRef.current) {
                scannerRef.current.clear().catch(error => {
                    console.error("Failed to clear scanner", error);
                });
                scannerRef.current = null;
            }
        };
    }, []); // Empty dependency array = mount once and stay alive!

    return (
        <div className="scanner-wrapper">
            {/* Ensure ID matches the one passed to constructor */}
            <div id={scannerId}></div>
        </div>
    );
};

export default Scanner;
