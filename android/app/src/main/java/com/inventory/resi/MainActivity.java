package com.inventory.resi;

import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;
import com.getcapacitor.BridgeActivity;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BridgeActivity {

    private final List<String[]> pendingFiles = new ArrayList<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setupJavascriptBridge();
        handleIncomingIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIncomingIntent(intent);
    }

    private void setupJavascriptBridge() {
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().addJavascriptInterface(new Object() {
                @JavascriptInterface
                public void flushPendingFiles() {
                    runOnUiThread(() -> flushPendingQueue());
                }
            }, "AndroidIntentBridge");
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
                // Try immediate flush and delayed flush to ensure webview receives it
                flushPendingQueue();
                if (getBridge() != null && getBridge().getWebView() != null) {
                    getBridge().getWebView().postDelayed(this::flushPendingQueue, 1500);
                }
            });

        } catch (Exception e) {
            Log.e("MainActivity", "Error processing intent URI: " + e.getMessage(), e);
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
