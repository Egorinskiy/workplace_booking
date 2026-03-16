const socket = io();

let myClientId = localStorage.getItem('clientId');
if (!myClientId) {
    myClientId = crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    localStorage.setItem('clientId', myClientId);
}

let myName = localStorage.getItem('userName');
let mySeatId = null; // будет определено после загрузки

// Элементы DOM
const userInfoDiv = document.getElementById('user-info');
const releaseBtn = document.getElementById('release-my-seat');

// Загружаем имя пользователя с сервера
async function loadUserName() {
    const response = await fetch(`/api/user?clientId=${myClientId}`);
    const data = await response.json();
    if (data.name) {
        myName = data.name;
        localStorage.setItem('userName', myName);
        userInfoDiv.textContent = `Вы: ${myName}`;
    } else {
        userInfoDiv.textContent = 'Вы не представились';
    }
}

// Загружаем состояние столов и отрисовываем
async function loadSeats() {
    const response = await fetch('/api/seats');
    const seats = await response.json();
    renderSeats(seats);
}

// Отрисовка столов по блокам
function renderSeats(seats) {
    // Очищаем все блоки
    document.querySelectorAll('.seats-grid').forEach(grid => grid.innerHTML = '');

    seats.forEach(seat => {
        const seatElement = document.createElement('div');
        seatElement.className = 'seat';
        if (seat.occupied) {
            seatElement.classList.add('occupied');
        }
        if (seat.clientId === myClientId) {
            seatElement.classList.add('my-seat');
            mySeatId = seat.id;
            releaseBtn.style.display = 'block';
        }

        seatElement.dataset.id = seat.id;
        seatElement.innerHTML = `
            <div>${seat.label}</div>
            ${seat.occupied ? `<div class="user-name">${seat.userName}</div>` : '<div class="user-name">Свободно</div>'}
        `;

        seatElement.addEventListener('click', () => onSeatClick(seat.id, seat.occupied));
        document.querySelector(`.seats-grid[data-block="${seat.block}"]`).appendChild(seatElement);
    });

    if (!mySeatId) {
        releaseBtn.style.display = 'none';
    }
}

// Обработчик клика по столу
async function onSeatClick(seatId, occupied) {
    if (occupied) {
        alert('Это место уже занято');
        return;
    }

    // Если пользователь уже занимает стол, предложим освободить
    if (mySeatId) {
        const confirmMove = confirm('Вы уже занимаете другое место. Хотите освободить его и занять это?');
        if (!confirmMove) return;
    }

    // Если имя неизвестно, запросим
    if (!myName) {
        const name = prompt('Введите ваше имя (ФИО):');
        if (!name) return;
        myName = name;
        localStorage.setItem('userName', myName);
        // Сохраняем на сервере
        await fetch('/api/user', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientId: myClientId, name: myName })
        });
    }

    // Отправляем запрос на занятие
    const response = await fetch('/api/occupy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: myClientId, seatId, name: myName })
    });

    if (!response.ok) {
        const error = await response.json();
        alert('Ошибка: ' + (error.error || 'Не удалось занять место'));
        // Обновим состояние на всякий случай
        loadSeats();
    } else {
        // Состояние обновится через сокет
    }
}

// Освободить своё место
releaseBtn.addEventListener('click', async () => {
    if (!mySeatId) return;
    const confirmRelease = confirm('Освободить ваше текущее место?');
    if (!confirmRelease) return;

    const response = await fetch('/api/occupy', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: myClientId })
    });

    if (!response.ok) {
        alert('Ошибка при освобождении');
    }
    // состояние обновится через сокет
});

// Слушаем обновления через сокет
socket.on('seats-updated', (seats) => {
    renderSeats(seats);
});

// Инициализация
loadUserName();
loadSeats();