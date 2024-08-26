# routes/main.py
from flask import Blueprint, render_template
from ilp_solver import solve_ilp

main_bp = Blueprint('main', __name__)

@main_bp.route('/', methods=['GET'], endpoint='main')
def main():
    return render_template('index.html')

@main_bp.route('/generate_rota', methods=['POST'], endpoint='generate_rota')
def generate_rota():
    solve_ilp()
    return render_template('index.html')
