# JARVIS 배포 방법 
 
## 코드 수정 후 배포 
deploy.bat 실행 
 
## 직접 명령어 
clasp push --force 
clasp deploy --deploymentId AKfycbyo3aaLvJjbYE2_XmabUyybIDj4ZVST0EJoIJzPPj8gyBb4D2sm2yigCtHZ7T9EbalE -d "updated" 
 
## 파일 구조 
- Code.gs : 백엔드 
- index.html : 프론트엔드 
- deploy.bat : 배포 자동화
