import React, { useEffect, useRef } from 'react';
import { Html5QrcodeScanner } from 'html5-qrcode';

const Scanner = ({ onScan }) => {
    // ID for the container
    const scannerId = "html5qr-code-full-region";
    const scannerRef = useRef(null);

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
            onScan(decodedText);
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
    }, [onScan]);

    return (
        <div className="scanner-wrapper">
            {/* Ensure ID matches the one passed to constructor */}
            <div id={scannerId}></div>
        </div>
    );
};

export default Scanner;
