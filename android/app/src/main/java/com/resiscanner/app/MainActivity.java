package com.resiscanner.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.util.Log;
import com.getcapacitor.BridgeActivity;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;

public class MainActivity extends BridgeActivity {

    private static final String TAG = "ResiScanner";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        if (intent == null) return;

        String action = intent.getAction();
        String type = intent.getType();

        if (Intent.ACTION_VIEW.equals(action) && "application/pdf".equals(type)) {
            Uri uri = intent.getData();
            if (uri != null) {
                // Beritahu web untuk menampilkan loading SEGERA
                getBridge().getWebView().post(() -> {
                    getBridge().getWebView().evaluateJavascript("window.showPdfLoading && window.showPdfLoading();", null);
                });

                // Proses baca file di background agar tidak membekukan UI
                new Thread(() -> {
                    try {
                        // Delay sedikit agar WebView benar-benar siap
                        Thread.sleep(1000);

                        InputStream inputStream = getContentResolver().openInputStream(uri);
                        if (inputStream == null) return;

                        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                        byte[] chunk = new byte[8192];
                        int bytesRead;
                        while ((bytesRead = inputStream.read(chunk)) != -1) {
                            buffer.write(chunk, 0, bytesRead);
                        }
                        inputStream.close();

                        String base64 = Base64.encodeToString(buffer.toByteArray(), Base64.NO_WRAP);
                        String filename = getFileNameFromUri(uri);

                        // Kirim data ke Web dan suruh sembunyikan loading
                        getBridge().getWebView().post(() -> {
                            String js = "window.onAndroidPdfIntent && window.onAndroidPdfIntent('" 
                                        + base64 + "', '" + filename + "');";
                            getBridge().getWebView().evaluateJavascript(js, null);
                        });

                    } catch (Exception e) {
                        Log.e(TAG, "Error reading PDF from intent", e);
                        getBridge().getWebView().post(() -> {
                            getBridge().getWebView().evaluateJavascript("window.hidePdfLoading && window.hidePdfLoading();", null);
                        });
                    }
                }).start();
            }
        }
    }

    private String getFileNameFromUri(Uri uri) {
        String path = uri.getLastPathSegment();
        if (path != null) return path.replaceAll("[^a-zA-Z0-9._-]", "_");
        return "shared.pdf";
    }
}
