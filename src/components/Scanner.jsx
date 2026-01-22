import React, { useEffect, useRef } from 'react';
import { Html5QrcodeScanner } from 'html5-qrcode';

const Scanner = ({ onScan }) => {
    const scannerRef = useRef(null);

    useEffect(() => {
        // Initialize scanner
        const scanner = new Html5QrcodeScanner(
            "reader",
            { fps: 10, qrbox: { width: 250, height: 250 } },
      /* verbose= */ false
        );

        const onScanSuccess = (decodedText, decodedResult) => {
            onScan(decodedText);
            // Optional: Don't clear scanner immediately to allow continuous scanning
            // scanner.clear(); 
        };

        const onScanFailure = (error) => {
            // ignore errors for better UX
        };

        scanner.render(onScanSuccess, onScanFailure);

        // Cleanup
        return () => {
            scanner.clear().catch(error => {
                console.error("Failed to clear html5-qrcode scanner. ", error);
            });
        };
    }, [onScan]);

    return (
        <div className="scanner-wrapper">
            <div id="reader"></div>
        </div>
    );
};

export default Scanner;
