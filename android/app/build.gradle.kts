plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Release signing with the JustApps key, kept outside the repository
// (~/.gradle/gradle.properties or environment variables).
fun secret(vararg names: String): String? = names.firstNotNullOfOrNull { (project.findProperty(it) as String?) ?: System.getenv(it) }
val keystore = secret("JUSTSHARE_KEYSTORE", "JUSTCLIP_KEYSTORE")

android {
    namespace = "it.justapps.justshare"
    compileSdk = 36

    defaultConfig {
        applicationId = "it.justapps.justshare"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
    }

    signingConfigs {
        create("release") {
            if (keystore != null) {
                storeFile = file(keystore)
                storePassword = secret("JUSTSHARE_KEYSTORE_PASSWORD", "JUSTCLIP_KEYSTORE_PASSWORD")
                keyAlias = secret("JUSTSHARE_KEY_ALIAS", "JUSTCLIP_KEY_ALIAS") ?: "justclip"
                keyPassword = secret("JUSTSHARE_KEY_PASSWORD", "JUSTSHARE_KEYSTORE_PASSWORD", "JUSTCLIP_KEY_PASSWORD", "JUSTCLIP_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (keystore != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { compose = true }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    implementation("com.google.android.gms:play-services-nearby:19.5.1")
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation(platform("androidx.compose:compose-bom:2025.12.01"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517")
}
