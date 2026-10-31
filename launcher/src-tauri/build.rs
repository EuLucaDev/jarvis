fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
        "estado_local",
        "entrar",
        "sair",
        "estado_remoto",
        "instalar",
        "abrir_jarvis",
        "abrir_link",
        "atualizar_launcher",
    ])))
    .expect("falha no build do Tauri");
}
