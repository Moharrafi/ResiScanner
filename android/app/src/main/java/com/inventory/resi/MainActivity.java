package com.inventory.resi;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Rect;
import android.graphics.pdf.PdfDocument;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintDocumentInfo;
import android.print.PrintManager;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;
import androidx.annotation.NonNull;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import java.io.ByteArrayOutputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {

    private static final String TAG = "MainActivity";
    private static final int REQ_BLUETOOTH_PERMISSIONS = 1001;
    private static final UUID SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");

    private final List<String[]> pendingFiles = new ArrayList<>();
    private final ExecutorService btExecutor = Executors.newSingleThreadExecutor();

    private BluetoothAdapter bluetoothAdapter;
    private BluetoothSocket btSocket;
    private OutputStream btOutputStream;
    private String connectedAddress = "";
    private String connectedName = "";
    private boolean receiverRegistered = false;
    private final Set<String> discoveredAddresses = new HashSet<>();

    private final BroadcastReceiver btDiscoveryReceiver = new BroadcastReceiver() {
        @SuppressLint("MissingPermission")
        @Override
        public void onReceive(Context context, Intent intent) {
            String action = intent.getAction();
            if (BluetoothDevice.ACTION_FOUND.equals(action)) {
                BluetoothDevice device = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                    ? intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice.class)
                    : intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                if (device != null && device.getAddress() != null) {
                    if (discoveredAddresses.add(device.getAddress())) {
                        String name = null;
                        try {
                            name = device.getName();
                        } catch (SecurityException ignored) {}
                        if (name == null || name.trim().isEmpty()) {
                            name = "Bluetooth Device (" + device.getAddress() + ")";
                        }
                        boolean bonded = false;
                        try {
                            bonded = device.getBondState() == BluetoothDevice.BOND_BONDED;
                        } catch (SecurityException ignored) {}
                        emitDeviceFound(name, device.getAddress(), bonded);
                    }
                }
            } else if (BluetoothAdapter.ACTION_DISCOVERY_FINISHED.equals(action)) {
                evalJs("if (window.onAndroidBluetoothScanFinished) { window.onAndroidBluetoothScanFinished(); }");
            }
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        Intent intent = getIntent();
        if (isPdfIntent(intent)) {
            handleIncomingIntent(intent);
            // Clear intent data so Capacitor does not attempt to navigate the WebView to content:// URI as a URL path
            intent.setData(null);
        }
        super.onCreate(savedInstanceState);

        BluetoothManager btManager = (BluetoothManager) getSystemService(Context.BLUETOOTH_SERVICE);
        bluetoothAdapter = btManager != null ? btManager.getAdapter() : BluetoothAdapter.getDefaultAdapter();

        setupJavascriptBridge();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        if (isPdfIntent(intent)) {
            handleIncomingIntent(intent);
            intent.setData(null);
        }
        super.onNewIntent(intent);
    }

    @Override
    public void onDestroy() {
        unregisterDiscoveryReceiver();
        closeBtConnection();
        btExecutor.shutdownNow();
        super.onDestroy();
    }

    private boolean isPdfIntent(Intent intent) {
        if (intent == null) return false;
        String action = intent.getAction();
        String type = intent.getType();
        return Intent.ACTION_VIEW.equals(action) ||
               (Intent.ACTION_SEND.equals(action) && type != null && type.contains("pdf")) ||
               (Intent.ACTION_SEND_MULTIPLE.equals(action) && type != null && type.contains("pdf"));
    }

    private void setupJavascriptBridge() {
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().addJavascriptInterface(new Object() {
                @JavascriptInterface
                public void flushPendingFiles() {
                    runOnUiThread(() -> flushPendingQueue());
                }
            }, "AndroidIntentBridge");

            getBridge().getWebView().addJavascriptInterface(new BluetoothJsBridge(), "AndroidBluetoothBridge");
        }
    }

    private boolean hasBluetoothPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
                && ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED;
        } else {
            return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        }
    }

    private void requestBluetoothPermissions() {
        runOnUiThread(() -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                ActivityCompat.requestPermissions(
                    this,
                    new String[] {
                        Manifest.permission.BLUETOOTH_CONNECT,
                        Manifest.permission.BLUETOOTH_SCAN
                    },
                    REQ_BLUETOOTH_PERMISSIONS
                );
            } else {
                ActivityCompat.requestPermissions(
                    this,
                    new String[] { Manifest.permission.ACCESS_FINE_LOCATION },
                    REQ_BLUETOOTH_PERMISSIONS
                );
            }
        });
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_BLUETOOTH_PERMISSIONS) {
            boolean allGranted = grantResults.length > 0;
            for (int r : grantResults) {
                if (r != PackageManager.PERMISSION_GRANTED) {
                    allGranted = false;
                    break;
                }
            }
            evalJs("if (window.onAndroidBluetoothPermissionResult) { window.onAndroidBluetoothPermissionResult(" + allGranted + "); }");
        }
    }

    private void unregisterDiscoveryReceiver() {
        if (receiverRegistered) {
            try {
                unregisterReceiver(btDiscoveryReceiver);
            } catch (Exception ignored) {}
            receiverRegistered = false;
        }
    }

    private void closeBtConnection() {
        try {
            if (btOutputStream != null) btOutputStream.close();
        } catch (Exception ignored) {}
        try {
            if (btSocket != null) btSocket.close();
        } catch (Exception ignored) {}
        btOutputStream = null;
        btSocket = null;
        connectedAddress = "";
        connectedName = "";
    }

    private void evalJs(String script) {
        runOnUiThread(() -> {
            if (getBridge() != null && getBridge().getWebView() != null) {
                getBridge().getWebView().evaluateJavascript(script, null);
            }
        });
    }

    private void emitDeviceFound(String name, String address, boolean bonded) {
        try {
            JSONObject obj = new JSONObject();
            obj.put("name", name);
            obj.put("address", address);
            obj.put("bonded", bonded);
            evalJs("if (window.onAndroidBluetoothDeviceFound) { window.onAndroidBluetoothDeviceFound(" + obj.toString() + "); }");
        } catch (Exception ignored) {}
    }

    private void emitError(String message) {
        String safe = JSONObject.quote(message != null ? message : "Bluetooth error");
        evalJs("if (window.onAndroidBluetoothError) { window.onAndroidBluetoothError(" + safe + "); }");
    }

    public class BluetoothJsBridge {
        @JavascriptInterface
        public boolean isAvailable() {
            return bluetoothAdapter != null;
        }

        @JavascriptInterface
        public boolean isConnected() {
            return btSocket != null && btSocket.isConnected() && btOutputStream != null;
        }

        @JavascriptInterface
        public String getConnectedAddress() {
            return connectedAddress;
        }

        @JavascriptInterface
        public String getConnectedName() {
            return connectedName;
        }

        @SuppressLint("MissingPermission")
        @JavascriptInterface
        public String getPairedDevices() {
            JSONArray arr = new JSONArray();
            if (bluetoothAdapter == null) return arr.toString();
            if (!hasBluetoothPermissions()) {
                requestBluetoothPermissions();
                return arr.toString();
            }
            try {
                Set<BluetoothDevice> paired = bluetoothAdapter.getBondedDevices();
                if (paired != null) {
                    for (BluetoothDevice d : paired) {
                        JSONObject obj = new JSONObject();
                        obj.put("name", d.getName() != null ? d.getName() : "Printer (" + d.getAddress() + ")");
                        obj.put("address", d.getAddress());
                        obj.put("bonded", true);
                        arr.put(obj);
                    }
                }
            } catch (Exception e) {
                Log.e(TAG, "getPairedDevices error", e);
            }
            return arr.toString();
        }

        @SuppressLint("MissingPermission")
        @JavascriptInterface
        public boolean startDiscovery() {
            if (bluetoothAdapter == null) {
                emitError("Perangkat tidak mendukung Bluetooth.");
                return false;
            }
            if (!hasBluetoothPermissions()) {
                requestBluetoothPermissions();
                return false;
            }
            if (!bluetoothAdapter.isEnabled()) {
                runOnUiThread(() -> {
                    try {
                        Intent enableBt = new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE);
                        startActivity(enableBt);
                    } catch (Exception ignored) {}
                });
                emitError("Bluetooth belum aktif. Silakan aktifkan Bluetooth lalu scan ulang.");
                return false;
            }

            try {
                if (bluetoothAdapter.isDiscovering()) {
                    bluetoothAdapter.cancelDiscovery();
                }
                discoveredAddresses.clear();

                // Emit paired devices immediately
                Set<BluetoothDevice> paired = bluetoothAdapter.getBondedDevices();
                if (paired != null) {
                    for (BluetoothDevice d : paired) {
                        if (d.getAddress() != null && discoveredAddresses.add(d.getAddress())) {
                            emitDeviceFound(
                                d.getName() != null ? d.getName() : "Printer (" + d.getAddress() + ")",
                                d.getAddress(),
                                true
                            );
                        }
                    }
                }

                if (!receiverRegistered) {
                    IntentFilter filter = new IntentFilter();
                    filter.addAction(BluetoothDevice.ACTION_FOUND);
                    filter.addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED);
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        registerReceiver(btDiscoveryReceiver, filter, Context.RECEIVER_EXPORTED);
                    } else {
                        registerReceiver(btDiscoveryReceiver, filter);
                    }
                    receiverRegistered = true;
                }

                boolean started = bluetoothAdapter.startDiscovery();
                if (!started) {
                    emitError("Gagal memulai pencarian Bluetooth. Pastikan Bluetooth & Lokasi aktif.");
                }
                return started;
            } catch (Exception e) {
                emitError("Gagal scan Bluetooth: " + e.getMessage());
                return false;
            }
        }

        @SuppressLint("MissingPermission")
        @JavascriptInterface
        public void stopDiscovery() {
            if (bluetoothAdapter != null && hasBluetoothPermissions()) {
                try {
                    if (bluetoothAdapter.isDiscovering()) {
                        bluetoothAdapter.cancelDiscovery();
                    }
                } catch (Exception ignored) {}
            }
        }

        @SuppressLint("MissingPermission")
        @JavascriptInterface
        public void connect(String address) {
            if (bluetoothAdapter == null || address == null || address.isEmpty()) {
                emitError("Alamat printer Bluetooth tidak valid.");
                return;
            }
            if (!hasBluetoothPermissions()) {
                requestBluetoothPermissions();
                return;
            }

            btExecutor.execute(() -> {
                try {
                    if (bluetoothAdapter.isDiscovering()) {
                        bluetoothAdapter.cancelDiscovery();
                    }
                    closeBtConnection();

                    BluetoothDevice device = bluetoothAdapter.getRemoteDevice(address);
                    String devName = device.getName() != null ? device.getName() : address;

                    BluetoothSocket socket = null;
                    try {
                        socket = device.createRfcommSocketToServiceRecord(SPP_UUID);
                        socket.connect();
                    } catch (Exception primaryEx) {
                        Log.w(TAG, "Primary RFCOMM failed, trying fallback channel 1", primaryEx);
                        try {
                            if (socket != null) socket.close();
                        } catch (Exception ignored) {}
                        socket = (BluetoothSocket) device.getClass()
                            .getMethod("createRfcommSocket", int.class)
                            .invoke(device, 1);
                        socket.connect();
                    }

                    btSocket = socket;
                    btOutputStream = socket.getOutputStream();
                    connectedAddress = address;
                    connectedName = devName;

                    JSONObject info = new JSONObject();
                    info.put("address", address);
                    info.put("name", devName);
                    evalJs("if (window.onAndroidBluetoothConnected) { window.onAndroidBluetoothConnected(" + info.toString() + "); }");
                } catch (Exception e) {
                    closeBtConnection();
                    emitError("Gagal menyambung ke printer (" + address + "): " + e.getMessage());
                }
            });
        }

        @JavascriptInterface
        public void disconnect() {
            btExecutor.execute(() -> {
                closeBtConnection();
                evalJs("if (window.onAndroidBluetoothDisconnected) { window.onAndroidBluetoothDisconnected(); }");
            });
        }

        @JavascriptInterface
        public void printBase64(String base64Bytes) {
            if (btSocket == null || !btSocket.isConnected() || btOutputStream == null) {
                emitError("Printer Bluetooth belum terhubung.");
                evalJs("if (window.onAndroidBluetoothPrintDone) { window.onAndroidBluetoothPrintDone(false, 'Printer belum terhubung'); }");
                return;
            }

            btExecutor.execute(() -> {
                try {
                    byte[] data = Base64.decode(base64Bytes, Base64.DEFAULT);
                    // Stream in 4KB blocks directly; BluetoothSocket RFCOMM handles hardware flow control natively
                    int chunkSize = 4096;
                    for (int i = 0; i < data.length; i += chunkSize) {
                        int len = Math.min(chunkSize, data.length - i);
                        btOutputStream.write(data, i, len);
                    }
                    btOutputStream.flush();
                    evalJs("if (window.onAndroidBluetoothPrintDone) { window.onAndroidBluetoothPrintDone(true, ''); }");
                } catch (Exception e) {
                    Log.e(TAG, "printBase64 failed", e);
                    String safeMsg = JSONObject.quote(e.getMessage() != null ? e.getMessage() : "Gagal mencetak");
                    evalJs("if (window.onAndroidBluetoothPrintDone) { window.onAndroidBluetoothPrintDone(false, " + safeMsg + "); }");
                }
            });
        }

        @JavascriptInterface
        public void printImageBase64(String base64Png, String title) {
            runOnUiThread(() -> {
                try {
                    byte[] decoded = Base64.decode(base64Png, Base64.DEFAULT);
                    Bitmap bitmap = BitmapFactory.decodeByteArray(decoded, 0, decoded.length);
                    if (bitmap == null) {
                        emitError("Gagal menyiapkan gambar untuk print.");
                        return;
                    }
                    PrintManager printManager = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                    if (printManager == null) {
                        emitError("Layanan Print Android tidak tersedia.");
                        return;
                    }
                    String jobName = (title != null && !title.isEmpty()) ? title : "Resi Scanner Print";
                    printManager.print(jobName, new BitmapPrintAdapter(MainActivity.this, bitmap, jobName), null);
                } catch (Exception e) {
                    emitError("Gagal membuka dialog print: " + e.getMessage());
                }
            });
        }
    }

    private static class BitmapPrintAdapter extends PrintDocumentAdapter {
        private final Context context;
        private final Bitmap bitmap;
        private final String jobName;
        private PrintAttributes printAttributes;

        BitmapPrintAdapter(Context context, Bitmap bitmap, String jobName) {
            this.context = context;
            this.bitmap = bitmap;
            this.jobName = jobName;
        }

        @Override
        public void onLayout(
            PrintAttributes oldAttributes,
            PrintAttributes newAttributes,
            CancellationSignal cancellationSignal,
            LayoutResultCallback callback,
            Bundle extras
        ) {
            this.printAttributes = newAttributes;
            if (cancellationSignal.isCanceled()) {
                callback.onLayoutCancelled();
                return;
            }
            PrintDocumentInfo info = new PrintDocumentInfo.Builder(jobName + ".pdf")
                .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
                .setPageCount(1)
                .build();
            callback.onLayoutFinished(info, true);
        }

        @Override
        public void onWrite(
            PageRange[] pages,
            ParcelFileDescriptor destination,
            CancellationSignal cancellationSignal,
            WriteResultCallback callback
        ) {
            PdfDocument pdfDocument = new PdfDocument();
            try {
                int pageWidth = printAttributes != null && printAttributes.getMediaSize() != null
                    ? (int) (printAttributes.getMediaSize().getWidthMils() * 72.0 / 1000.0)
                    : 288;
                int pageHeight = printAttributes != null && printAttributes.getMediaSize() != null
                    ? (int) (printAttributes.getMediaSize().getHeightMils() * 72.0 / 1000.0)
                    : 432;

                PdfDocument.PageInfo pageInfo = new PdfDocument.PageInfo.Builder(
                    Math.max(100, pageWidth),
                    Math.max(100, pageHeight),
                    1
                ).create();
                PdfDocument.Page page = pdfDocument.startPage(pageInfo);
                Canvas canvas = page.getCanvas();

                float scale = Math.min(
                    (float) canvas.getWidth() / bitmap.getWidth(),
                    (float) canvas.getHeight() / bitmap.getHeight()
                );
                int drawW = Math.round(bitmap.getWidth() * scale);
                int drawH = Math.round(bitmap.getHeight() * scale);
                int left = (canvas.getWidth() - drawW) / 2;
                int top = 0;

                canvas.drawBitmap(bitmap, null, new Rect(left, top, left + drawW, top + drawH), null);
                pdfDocument.finishPage(page);

                try (FileOutputStream out = new FileOutputStream(destination.getFileDescriptor())) {
                    pdfDocument.writeTo(out);
                }
                callback.onWriteFinished(new PageRange[] { PageRange.ALL_PAGES });
            } catch (Exception e) {
                callback.onWriteFailed(e.getMessage());
            } finally {
                pdfDocument.close();
            }
        }
    }

    private void handleIncomingIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        String type = intent.getType();

        if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            processUri(intent.getData());
        } else if (Intent.ACTION_SEND.equals(action) && (type != null && type.contains("pdf"))) {
            Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (uri != null) processUri(uri);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action) && (type != null && type.contains("pdf"))) {
            ArrayList<Uri> uris = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (uris != null) {
                for (Uri uri : uris) processUri(uri);
            }
        }
    }

    private void processUri(Uri uri) {
        try {
            InputStream inputStream = getContentResolver().openInputStream(uri);
            if (inputStream == null) return;

            ByteArrayOutputStream byteBuffer = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int len;
            while ((len = inputStream.read(buffer)) != -1) {
                byteBuffer.write(buffer, 0, len);
            }
            byte[] bytes = byteBuffer.toByteArray();
            inputStream.close();

            String base64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
            String fileName = getFileName(uri);

            synchronized (pendingFiles) {
                pendingFiles.add(new String[]{fileName, base64});
            }

            runOnUiThread(() -> {
                flushPendingQueue();
                if (getBridge() != null && getBridge().getWebView() != null) {
                    getBridge().getWebView().postDelayed(this::flushPendingQueue, 1500);
                }
            });

        } catch (Exception e) {
            Log.e(TAG, "Error processing intent URI: " + e.getMessage(), e);
        }
    }

    private void flushPendingQueue() {
        if (getBridge() == null || getBridge().getWebView() == null) return;

        synchronized (pendingFiles) {
            if (pendingFiles.isEmpty()) return;

            for (String[] fileData : new ArrayList<>(pendingFiles)) {
                String fileName = fileData[0].replace("'", "\\'").replace("\n", "").replace("\r", "");
                String base64 = fileData[1];
                String js = String.format(
                    "if (window.handleAndroidPdfFile) { window.handleAndroidPdfFile('%s', '%s'); }",
                    fileName, base64
                );
                getBridge().getWebView().evaluateJavascript(js, null);
            }
            pendingFiles.clear();
        }
    }

    private String getFileName(Uri uri) {
        String name = "Resi_Document.pdf";
        try (Cursor cursor = getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (nameIndex != -1) {
                    name = cursor.getString(nameIndex);
                }
            }
        } catch (Exception ignored) {}
        return name;
    }
}
