fn main() {
    // comandos do app que as páginas (servidas pelo núcleo, em http://127.0.0.1) podem chamar
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
        "hud_mostrar",
        "hud_minimizar",
        "hud_esconder",
        "hud_estado",
        "painel_abrir",
        "configuracao_pronta",
        "regioes",
        "memoria_abrir",
    ])))
    .expect("falha no build do Tauri");
}
