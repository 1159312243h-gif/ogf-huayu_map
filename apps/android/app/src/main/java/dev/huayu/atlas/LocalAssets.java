package dev.huayu.atlas;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import org.json.*;
import java.io.*;
import java.security.MessageDigest;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.*;

// Serve only build-manifest files under the unchanged production HTTPS origin.
final class LocalAssets {
    private static final String HOST="ogf-atlas.pages.dev";
    private final Context context;
    private final Map<String,JSONObject> files=new HashMap<>();
    private final Set<String> verified=Collections.synchronizedSet(new HashSet<>());
    final String revision;
    LocalAssets(Context context) throws Exception {
        this.context=context;
        JSONObject manifest=new JSONObject(new String(read("desktop-assets.json"),"UTF-8"));
        if(!"huayu-desktop-assets-v1".equals(manifest.getString("schema"))||manifest.getInt("runtime")!=1)throw new IOException("Unsupported local resources");
        revision=manifest.getString("revision");
        JSONArray list=manifest.getJSONArray("files");
        for(int i=0;i<list.length();i++){JSONObject file=list.getJSONObject(i);String name=file.getString("path");
            if(name.startsWith("/")||name.contains("..")||name.contains("\\")||name.startsWith("_")||name.contains("-server.js"))throw new IOException("Invalid local resource");files.put(name,file);}
    }
    private byte[] read(String name) throws IOException {
        try(InputStream in=context.getAssets().open("huayu/"+name);ByteArrayOutputStream out=new ByteArrayOutputStream()){
            byte[] part=new byte[65536];int size;while((size=in.read(part))!=-1)out.write(part,0,size);return out.toByteArray();
        }
    }
    private String mime(String name){
        if(name.endsWith(".js"))return "text/javascript";if(name.endsWith(".css"))return "text/css";
        if(name.endsWith(".html"))return "text/html";if(name.endsWith(".json"))return "application/json";
        if(name.endsWith(".gz"))return "application/gzip";if(name.endsWith(".png"))return "image/png";
        if(name.endsWith(".webp"))return "image/webp";if(name.endsWith(".svg"))return "image/svg+xml";
        if(name.endsWith(".glb"))return "model/gltf-binary";return "application/octet-stream";
    }
    WebResourceResponse intercept(WebResourceRequest request){
        Uri uri=request.getUrl();
        if(!"GET".equals(request.getMethod())||!"https".equals(uri.getScheme())||!HOST.equals(uri.getHost())||(uri.getPort()!=-1&&uri.getPort()!=443)||uri.getUserInfo()!=null)return null;
        for(String key:request.getRequestHeaders().keySet())if("X-Huayu-Cache-Network".equalsIgnoreCase(key))return null;
        String name=uri.getPath();if(name==null)return null;name=name.replaceFirst("^/","");if(name.isEmpty())name="index.html";if("apps".equals(name))name="apps.html";
        if(name.equals("app-sw.js")||name.equals("app-cache-version.js")||name.equals("app-cache-policy.js"))return null;
        JSONObject entry=files.get(name);if(entry==null)return null;
        // Live snapshots go through the common updater; bundled snapshots are only its explicit seed fallback.
        if("data".equals(entry.optString("kind"))&&!"1".equals(uri.getQueryParameter("huayuSeed"))){
            try{
                HttpURLConnection connection=(HttpURLConnection)new URL(uri.toString()).openConnection();connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(5000);connection.setReadTimeout(20000);connection.setRequestProperty("Cache-Control","no-cache");
                int status=connection.getResponseCode();
                if(status==200){Map<String,String> headers=new HashMap<>();headers.put("Cache-Control","no-store");headers.put("X-Huayu-App-Source","android-online");
                    InputStream stream=new FilterInputStream(connection.getInputStream()){@Override public void close() throws IOException{try{super.close();}finally{connection.disconnect();}}};
                    return new WebResourceResponse(mime(name),"UTF-8",200,"OK",headers,stream);
                }
                connection.disconnect();if(status<500)return null;
            }catch(IOException error){/* Network failure keeps the original complete bundled snapshot. */}
        }
        try {
            byte[] bytes=read(name);
            if(!verified.contains(name)){
                byte[] digest=MessageDigest.getInstance("SHA-256").digest(bytes);StringBuilder sum=new StringBuilder();for(byte b:digest)sum.append(String.format(Locale.ROOT,"%02x",b&255));
                if(bytes.length!=entry.getLong("bytes")||!sum.toString().equals(entry.getString("sha256")))return null;verified.add(name);
            }
            Map<String,String> headers=new HashMap<>();headers.put("Cache-Control","no-store");headers.put("X-Huayu-App-Source","android-bundle");
            headers.put("X-Content-Type-Options","nosniff");
            return new WebResourceResponse(mime(name),"UTF-8",200,"OK",headers,new ByteArrayInputStream(bytes));
        }catch(Exception error){return null;}
    }
}
