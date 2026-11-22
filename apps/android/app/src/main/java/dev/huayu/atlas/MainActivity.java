package dev.huayu.atlas;

import android.app.*;
import android.os.*;
import android.content.*;
import android.net.Uri;
import android.graphics.Color;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import androidx.webkit.*;
import org.json.*;
import java.io.*;
import java.util.*;

public class MainActivity extends Activity {
    private static final String ORIGIN = "https://ogf-atlas.pages.dev";
    private static final String START = ORIGIN + "/?app=native";
    private WebView web;
    private LinearLayout layout;
    private ValueCallback<Uri[]> fileInput;
    private JavaScriptReplyProxy finishReply;
    private String finishId, token, exportName, exportMime;
    private File exportFile;
    private OutputStream exportStream;
    private long expected, received;
    private static final long MAX_EXPORT = 9007199254740991L;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setBackgroundColor(Color.rgb(243,246,245));
        setContentView(layout);
        // Let the OS reserve display cutouts, system bars and the on-screen keyboard.
        layout.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        web = new WebView(this);
        layout.addView(web, new LinearLayout.LayoutParams(-1, -1));
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(true);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            unavailable("请更新 Android System WebView 后重新打开应用。");
            return;
        }
        WebViewCompat.addWebMessageListener(web, "huayuNative", Collections.singleton(ORIGIN),
            (view, message, sourceOrigin, mainFrame, reply) -> {
                if (!mainFrame || !trusted(sourceOrigin.toString())) return;
                try { handle(new JSONObject(message.getData()), reply); }
                catch (Exception error) { reply(reply, "", false, null, "文件保存请求无效"); }
            });
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String value = request.getUrl().toString();
                if (trusted(value)) return false;
                if (request.isForMainFrame()) external(value);
                return true;
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                cancelExport();
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) unavailable("暂时无法连接地图，请检查网络后重试。");
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                    FileChooserParams params) {
                if (fileInput != null) fileInput.onReceiveValue(null);
                fileInput = callback;
                try { startActivityForResult(params.createIntent(), 101); }
                catch (ActivityNotFoundException error) { fileInput.onReceiveValue(null); fileInput=null; return false; }
                return true;
            }
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean gesture, Message message) {
                if (!gesture) return false;
                WebView child = new WebView(MainActivity.this);
                child.setWebViewClient(new WebViewClient() {
                    @Override public boolean shouldOverrideUrlLoading(WebView unused, WebResourceRequest request) {
                        external(request.getUrl().toString()); child.destroy(); return true;
                    }
                });
                ((WebView.WebViewTransport)message.obj).setWebView(child);
                message.sendToTarget();
                return true;
            }
        });
        if (state == null || web.restoreState(state) == null) web.loadUrl(START);
    }
    private boolean trusted(String value) {
        try {
            Uri uri=Uri.parse(value);
            return "https".equals(uri.getScheme()) && "ogf-atlas.pages.dev".equals(uri.getHost())
                && (uri.getPort()==-1 || uri.getPort()==443) && uri.getUserInfo()==null;
        } catch (Exception error) { return false; }
    }
    private void external(String value) {
        Uri uri=Uri.parse(value);
        if (!"https".equals(uri.getScheme()) && !"http".equals(uri.getScheme())) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW,uri)); }
        catch (ActivityNotFoundException error) { Toast.makeText(this,"未找到可打开链接的浏览器",Toast.LENGTH_SHORT).show(); }
    }
    private void unavailable(String text) {
        web.setVisibility(View.GONE);
        if (layout.getChildCount()>1) layout.removeViews(1,layout.getChildCount()-1);
        TextView label=new TextView(this);
        label.setText(text);label.setTextSize(18);label.setPadding(28,80,28,28);layout.addView(label);
        Button retry=new Button(this);retry.setText("重新连接");
        retry.setOnClickListener(view -> {
            layout.removeViews(1,layout.getChildCount()-1);web.setVisibility(View.VISIBLE);web.loadUrl(START);
        });
        layout.addView(retry);
        Button browser=new Button(this);browser.setText("在浏览器打开");
        browser.setOnClickListener(view->external(START));layout.addView(browser);
    }
    private void reply(JavaScriptReplyProxy reply, String id, boolean ok, Object result, String error) {
        try { JSONObject value=new JSONObject().put("id",id).put("ok",ok);
            if(ok)value.put("result",result==null?JSONObject.NULL:result);else value.put("error",error);
            reply.postMessage(value.toString());
        } catch (Exception ignored) {}
    }
    private void handle(JSONObject message, JavaScriptReplyProxy reply) {
        String id=message.optString("id"), action=message.optString("action");
        try {
            if (!trusted(web.getUrl())) throw new IOException();
            if ("begin".equals(action)) {
                if (exportFile!=null) {reply(reply,id,false,null,"请先完成当前文件保存");return;}
                expected=message.getLong("size");
                if(expected<0||expected>MAX_EXPORT) {reply(reply,id,false,null,"文件大小无效");return;}
                exportName=message.optString("name","华域地图数据").replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]","-");
                if(exportName.length()>120)exportName=exportName.substring(0,120);
                if(exportName.trim().isEmpty()||exportName.matches("\\.+"))exportName="华域地图数据";
                exportMime=message.optString("mime","application/octet-stream");
                if(!exportMime.matches("[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+"))exportMime="application/octet-stream";
                exportFile=File.createTempFile("huayu-export-",".tmp",getCacheDir());
                exportStream=new FileOutputStream(exportFile);token=UUID.randomUUID().toString();received=0;
                reply(reply,id,true,token,null);return;
            }
            if(token==null||!token.equals(message.optString("token"))) {reply(reply,id,false,null,"保存任务已失效");return;}
            if ("chunk".equals(action)) {
                String data=message.getString("data");if(data.length()>262144)throw new IOException();
                byte[] bytes=android.util.Base64.decode(data,android.util.Base64.NO_WRAP);
                if(received+bytes.length>expected)throw new IOException();
                exportStream.write(bytes);received+=bytes.length;reply(reply,id,true,null,null);
            } else if ("finish".equals(action)) {
                if(received!=expected)throw new IOException();
                exportStream.close();exportStream=null;finishReply=reply;finishId=id;
                Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType(exportMime).putExtra(Intent.EXTRA_TITLE,exportName);
                startActivityForResult(intent,102);
            } else if ("cancel".equals(action)) {
                cancelExport();reply(reply,id,true,null,null);
            } else reply(reply,id,false,null,"未知保存操作");
        } catch (Exception error) {cancelExport();reply(reply,id,false,null,"文件保存失败，请重试");}
    }
    private void cancelExport() {
        try {if(exportStream!=null)exportStream.close();}catch(IOException ignored){}
        if(exportFile!=null)exportFile.delete();
        exportStream=null;exportFile=null;token=null;
        if(finishReply!=null)reply(finishReply,finishId,false,null,"保存已取消");
        finishReply=null;finishId=null;
    }
    @Override protected void onActivityResult(int request,int result,Intent data) {
        super.onActivityResult(request,result,data);
        if(request==101&&fileInput!=null) {fileInput.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result,data));fileInput=null;}
        if(request==102&&finishReply!=null) {
            JavaScriptReplyProxy callback=finishReply;String id=finishId;finishReply=null;
            try {
                if(result==RESULT_OK&&data!=null&&data.getData()!=null) {
                    try(InputStream source=new FileInputStream(exportFile);
                        OutputStream output=getContentResolver().openOutputStream(data.getData(),"w")) {
                        if(output==null)throw new IOException();
                        byte[] bytes=new byte[65536];int count;while((count=source.read(bytes))!=-1)output.write(bytes,0,count);
                    }
                    reply(callback,id,true,new JSONObject().put("cancelled",false),null);
                } else reply(callback,id,true,new JSONObject().put("cancelled",true),null);
            } catch(Exception error) {
                if(data!=null && data.getData()!=null)try { android.provider.DocumentsContract.deleteDocument(getContentResolver(),data.getData()); } catch(Exception ignored) {}
                reply(callback,id,false,null,"未能写入所选文件，请重试");
            }
            finally {cancelExport();}
        }
    }
    @Override protected void onSaveInstanceState(Bundle state) {web.saveState(state);super.onSaveInstanceState(state);}
    @Override public void onBackPressed() {if(web.canGoBack())web.goBack();else super.onBackPressed();}
    @Override protected void onDestroy() {cancelExport();if(fileInput!=null)fileInput.onReceiveValue(null);web.destroy();super.onDestroy();}
}
