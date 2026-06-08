import java.io.File
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

// 真机/无线调试 + adb reverse → 127.0.0.1；模拟器 → 在 local.properties 写 copilot.host=10.0.2.2
val localProperties = Properties().apply {
    rootProject.file("local.properties").takeIf { it.exists() }?.inputStream()?.use(::load)
}
val copilotHost: String = localProperties.getProperty("copilot.host", "127.0.0.1")

val copilotNetworkResPath = layout.buildDirectory.dir("generated/res/copilotNetwork")

val generateCopilotNetworkSecurityConfig by tasks.registering {
    val outDir = copilotNetworkResPath.get().asFile
    outputs.dir(outDir)
    doLast {
        val xmlDir = File(outDir, "xml").apply { mkdirs() }
        val knownHosts = setOf("127.0.0.1", "10.0.2.2", "localhost")
        val extraDomain = if (copilotHost !in knownHosts) {
            "        <domain includeSubdomains=\"false\">$copilotHost</domain>\n"
        } else {
            ""
        }
        File(xmlDir, "network_security_config.xml").writeText(
            """
            <?xml version="1.0" encoding="utf-8"?>
            <network-security-config>
                <domain-config cleartextTrafficPermitted="true">
                    <domain includeSubdomains="false">127.0.0.1</domain>
                    <domain includeSubdomains="false">10.0.2.2</domain>
                    <domain includeSubdomains="false">localhost</domain>
            $extraDomain    </domain-config>
            </network-security-config>
            """.trimIndent() + "\n",
        )
    }
}

android {
    namespace = "com.example.cpr_new"
    compileSdk {
        version = release(36) {
            minorApiLevel = 1
        }
    }

    defaultConfig {
        applicationId = "com.example.cpr_new"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        buildConfigField("String", "COPILOT_BASE_URL", "\"http://$copilotHost:8787\"")
        buildConfigField("String", "COPILOT_WS_URL", "\"ws://$copilotHost:8787/ws/live\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    sourceSets {
        getByName("main") {
            res.srcDir("build/generated/res/copilotNetwork")
        }
    }
}

tasks.named("preBuild").configure {
    dependsOn(generateCopilotNetworkSecurityConfig)
}

dependencies {
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    // 第 4 部分新增：协程 + Compose 侧 ViewModel / 生命周期感知收集
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    // 第 4 部分：CameraX 摄像头取流与预览
    implementation(libs.androidx.camera.core)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.okhttp)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.android)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(libs.androidx.junit)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
    debugImplementation(libs.androidx.compose.ui.tooling)
}