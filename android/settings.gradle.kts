pluginManagement {
    repositories {
        maven {
            url = uri("http://maven.aliyun.com/repository/google")
            isAllowInsecureProtocol = true
        }
        maven {
            url = uri("http://maven.aliyun.com/repository/gradle-plugin")
            isAllowInsecureProtocol = true
        }
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        maven { url = uri("https://maven.aliyun.com/repository/gradle-plugin") }
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        mavenCentral()
        maven {
            url = uri("http://maven.aliyun.com/repository/google")
            isAllowInsecureProtocol = true
        }
        maven {
            url = uri("http://maven.aliyun.com/repository/central")
            isAllowInsecureProtocol = true
        }
        maven {
            url = uri("http://maven.aliyun.com/repository/public")
            isAllowInsecureProtocol = true
        }
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        maven { url = uri("https://maven.aliyun.com/repository/central") }
        maven { url = uri("https://maven.aliyun.com/repository/public") }
        google()
    }
}

rootProject.name = "FirstAidCopilotAndroid"
include(":app")
